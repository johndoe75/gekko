var cexio = require('cexio');

var moment = require('moment');
var nstore = require('nstore');
nstore= nstore.extend(require('nstore/query')());
var util = require('../util');
var _ = require('lodash');
var log = require('../log')

var Trader = function(config) {
  this.key = config.key;
  this.secret = config.secret;
  this.pair = 'ghs_' + config.currency.toLowerCase();
  this.name = 'cex.io';
  this.next_tid= 0;

  _.bindAll(this);

  // this.cexio = new cexio(this.key, this.secret);
  this.cexio= new cexio(this.pair);
}

Trader.prototype.buy = function(amount, price, callback) {
  // Prevent "You incorrectly entered one of fields."
  // because of more than 8 decimals.
  amount *= 100000000;
  amount = Math.floor(amount);
  amount /= 100000000;

  var set = function(err, data) {
    if(err)
      log.error('unable to buy:', err);

    callback(data.order_id);
  };

  // workaround for nonce error
  setTimeout(_.bind(function() {
    this.cexio.place_order('buy', 
      amount, price, _.bind(set, this));
  }, this), 1000);
}

Trader.prototype.sell = function(amount, price, callback) {
  // Prevent "You incorrectly entered one of fields."
  // because of more than 8 decimals.
  amount *= 100000000;
  amount = Math.ceil(amount);
  amount /= 100000000;

  var set = function(err, data) {
    if(err)
      log.error('unable to sell:', err);

    callback(err, data.order_id);
  };

  // workaround for nonce error
  setTimeout(_.bind(function() {
    this.cexio.place_order('sell',
      amount, price, _.bind(set, this));
  }, this), 1000);
}

// if cex.io errors we try the same call again after
// 5 seconds or half a second if there is haste
Trader.prototype.retry = function(method, callback, haste) {
  var wait = +moment.duration(haste ? 0.5 : 5, 'seconds');
  log.debug(this.name , 'returned an error, retrying..');
  setTimeout(
    _.bind(method, this),
    wait,
    _.bind(callback, this)
  );
}

Trader.prototype.getTrades = function(since, callback, descending) {
  if(since && !_.isNumber(since))
    since= 263000;
  else
    since= this.next_tid;

  var args = _.toArray(arguments);
  var next_tid= 0;
  //console.log('fetching since (incl.) tid:' + since);

  this.cexio.trades({since: since}, _.bind(function(err, trades) {
    if(err || !trades)
      return this.retry(this.getTrades, args);
    if(trades.length === 0)
      return this.retry(this.getTrades, args);
    // remember, where we are for the next fetch
    this.next_tid= ++(trades[0].tid);
    // cex.io returns descending trade list
    callback(trades.reverse());
  }, this));
}

Trader.prototype.getPortfolio = function(callback) {
  var calculate = function(err, data) {
    if(err)
      return this.retry(this.cexio.getInfo, calculate);

    var portfolio = [];
    _.each(data.funds, function(amount, asset) {
      portfolio.push({name: asset.toUpperCase(), amount: amount});
    });
    callback(err, portfolio);
  }
  this.cexio.getInfo(_.bind(calculate, this));
}

Trader.prototype.getTicker = function(callback) {
  // cexio-e doesn't state asks and bids in its ticker
  var set = function(err, data) {
    var ticker = _.extend(data.ticker, {
      ask: data.ticker.buy,
      bid: data.ticker.sell
    });
    callback(err, ticker);
  }
  this.cexio.ticker(this.pair, _.bind(set, this));
}

Trader.prototype.getFee = function(callback) {
  // cexio-e doesn't have different fees based on orders
  // at this moment it is always 0.2%
  callback(false, 0.002);
}

Trader.prototype.checkOrder = function(order, callback) {
  var check = function(err, result) {
    // cexio returns an error when you have no open trades
    // right now we assume on every error that the order
    // was filled.
    //
    // TODO: check whether the error stats that there are no
    // open trades or that there is something else.
    if(err)
      callback(false, true);
    else
      callback(err, !result[order]);
  };

  this.cexio.orderList({}, _.bind(check, this));
}

Trader.prototype.cancelOrder = function(order) {
  // TODO: properly test
  var devNull = function() {}
  this.cexio.cancel_order(null, devNull, order);
}

module.exports = Trader;
