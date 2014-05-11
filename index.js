var http = require('http');
var https = require('https');
var httpProxy = require('http-proxy');
var url = require('url');
var domain = require('domain');
var EventEmitter = require('events').EventEmitter;
var async = require('async');

var LoadBalancer = function (options) {
	var self = this;
	
	this._errorDomain = domain.create();
	this._errorDomain.on('error', function (err) {
		if (!err.message || (err.message != 'read ECONNRESET' && err.message != 'socket hang up')) {
			self.emit('error', err);
		}
	});
	
	this.MIDDLEWARE_REQUEST = 'request';
	this.MIDDLEWARE_UPGRADE = 'upgrade';
	
	this._middleware = {};
	this._middleware[this.MIDDLEWARE_REQUEST] = [];
	this._middleware[this.MIDDLEWARE_UPGRADE] = [];
	
	this.protocol = options.protocol;
	this.protocolOptions = options.protocolOptions;
	
	this.sourcePort = options.sourcePort;
	this.host = options.host;
	
	this.dataKey = options.dataKey;
	this.statusCheckInterval = options.statusCheckInterval || 5000;
	this.checkStatusTimeout = options.checkStatusTimeout || 10000;
	this.statusURL = options.statusURL || '/~status';

	this._destRegex = /^([^_]*)_([^_]*)_([^_]*)_/;
	this._sidRegex = /([^A-Za-z0-9]|^)s?sid=([^;]*)/;
	
	this.setWorkers(options.workers);

	this._proxyHTTP = this._errorDomain.bind(this._proxyHTTP.bind(this));
	this._proxyWebSocket = this._errorDomain.bind(this._proxyWebSocket.bind(this));
	
	this.workerStatuses = {};
	this.leastBusyPort = this._randomPort();

	this._proxy = httpProxy.createProxyServer({
		xfwd: true,
		ws: true
	});
	
	this._proxy.on('error', function (err, req, res) {
		if (res.writeHead) {
			res.writeHead(500, {
				'Content-Type': 'text/html'
			});
		}
		
		res.end('Proxy error - ' + (err.message || err));
	});
	
	if (this.protocol == 'https') {
		this._server = https.createServer(this.protocolOptions, this._handleRequest.bind(this));
	} else {
		this._server = http.createServer(this._handleRequest.bind(this));
	}
	
	this._errorDomain.add(this._server);
	
	this._server.on('upgrade', this._handleUpgrade.bind(this));
	
	if (options.appBalancerControllerPath) {
		this.balancerController = require(options.appBalancerControllerPath);
		this.balancerController.run(this);
	}
	
	this._server.listen(this.sourcePort);
};

LoadBalancer.prototype = Object.create(EventEmitter.prototype);

LoadBalancer.prototype.addMiddleware = function (type, middleware) {
	this._middleware[type].push(middleware);
};

LoadBalancer.prototype._handleRequest = function (req, res) {
	var self = this;
	async.applyEachSeries(this._middleware[this.MIDDLEWARE_REQUEST], req, res, function (err) {
		if (err) {
			self._errorDomain.emit('error', err);
		} else {
			self._proxyHTTP(req, res);
		}
	});
};

LoadBalancer.prototype._handleUpgrade = function (req, socket, head) {
	var self = this;
	async.applyEachSeries(this._middleware[this.MIDDLEWARE_UPGRADE], req, socket, head, function (err) {
		if (err) {
			self._errorDomain.emit('error', err);
		} else {
			self._proxyWebSocket(req, socket, head);
		}
	});
};

LoadBalancer.prototype._proxyHTTP = function (req, res) {
	var dest = this._parseDest(req);
	if (dest) {
		if (this.destPorts[dest.port] == null) {
			dest.port = this._randomPort();
		}
	} else {
		dest = {
			host: 'localhost',
			port: this.leastBusyPort
		};
	}
	
	this._proxy.web(req, res, {
		target: dest
	});
};

LoadBalancer.prototype._proxyWebSocket = function (req, socket, head) {
	var dest = this._parseDest(req);
	
	if (dest) {
		if (this.destPorts[dest.port] == null) {
			dest.port = this._randomPort();
		}
	} else {
		dest = {
			host: 'localhost',
			port: this.leastBusyPort
		};
	}

	this._proxy.ws(req, socket, head, {
		target: dest
	});
};

LoadBalancer.prototype.setWorkers = function (workers) {
	this.destPorts = {};
	var i;
	
	for (i in workers) {
		this.destPorts[workers[i].port] = 1;
	}
	this.workers = workers;
	
	setInterval(this._errorDomain.bind(this._updateStatus.bind(this)), this.statusCheckInterval);
};

LoadBalancer.prototype._randomPort = function () {
	var rand = Math.floor(Math.random() * this.workers.length);
	return this.workers[rand].port;
};

LoadBalancer.prototype.calculateLeastBusyPort = function () {
	var minBusiness = Infinity;
	var leastBusyPort;
	var httpRPM, ioRPM, clientCount, business;
	
	for (var i in this.workerStatuses) {
		if (this.workerStatuses[i]) {
			clientCount = this.workerStatuses[i].clientCount;
			httpRPM = this.workerStatuses[i].httpRPM;
			ioRPM = this.workerStatuses[i].ioRPM;
		} else {
			clientCount = Infinity;
			httpRPM = Infinity;
			ioRPM = Infinity;
		}
		business = httpRPM + ioRPM + clientCount;
		
		if (business < minBusiness) {
			minBusiness = business;
			leastBusyPort = parseInt(i);
		}
	}
	if (minBusiness == Infinity) {
		leastBusyPort = this._randomPort();
	}
	
	this.leastBusyPort = leastBusyPort;
};

LoadBalancer.prototype._updateStatus = function () {
	var self = this;
	var statusesRead = 0;
	var workerCount = this.workers.length;
	
	var body = {
		dataKey: self.dataKey
	};
	
	for (var i in this.workers) {
		(function (worker) {
			var options = {
				hostname: 'localhost',
				port: worker.port,
				method: 'POST',
				path: self.statusURL
			};
			
			var req = http.request(options, function (res) {
				res.setEncoding('utf8');
				var buffers = [];
				
				res.on('data', function (chunk) {
					buffers.push(chunk);
				});
				
				res.on('end', function () {
					var result = Buffer.concat(buffers).toString();
					if (result) {
						try {
							self.workerStatuses[worker.port] = JSON.parse(result);
						} catch (err) {
							self.workerStatuses[worker.port] = null;
						}						
					} else {
						self.workerStatuses[worker.port] = null;
					}
					
					if (++statusesRead >= workerCount) {
						self.calculateLeastBusyPort.call(self);
					}
				});
			});
			
			req.on('socket', function (socket) {
				socket.setTimeout(self.checkStatusTimeout);
				socket.on('timeout', function () {
					req.abort();
				})
			});
			
			req.write(JSON.stringify(body));
			req.end();
		})(this.workers[i]);
	}
};

LoadBalancer.prototype._parseDest = function (req) {
	if (!req.headers || !req.headers.host) {
		return null;
	}

	var urlData = url.parse(req.url);
	var query = urlData.query || '';
	var cookie = '';
	
	if (req.headers && req.headers.cookie) {
		cookie = req.headers.cookie;
	}
	
	if (!query && !cookie) {
		return null;
	}
	
	var matches = query.match(this._sidRegex) || cookie.match(this._sidRegex);
	
	if (!matches) {
		return null;
	}
	
	var routString = matches[2];
	var destMatch = routString.match(this._destRegex);
	
	if (!destMatch) {
		return null;
	}
	
	var dest = {
		host: 'localhost',
		port: parseInt(destMatch[2]) || this.leastBusyPort
	};
	
	return dest;
};

module.exports = LoadBalancer;