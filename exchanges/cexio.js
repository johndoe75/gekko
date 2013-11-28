var cexio= require('cexio'),
   moment= require('moment'),
     nedb= require('nedb'),
    async= require('async'),
       db= new nedb({filename: 'cexio.db', autoload: true}),
        _= require('lodash'),
     util= require('../util'),
      log= require('../log');

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

Trader.prototype.getTrades = function(since, callback, descending) {
  var self= this;
  var last_tid= next_tid= 0;

  if(since && !_.isNumber(since))
    since = util.toMicro(since);

  var args = _.toArray(arguments);

  async.waterfall([
    function(callback) {
      db.find({}, function(err, docs) {
        if(!docs || docs.length === 0)
          tid= 263000;
        else
          tid= 1 + _.max(docs, 'tid').tid;

        //log.info(self.name, 'Updating cex.io historical data store');
        log.debug(self.name, 'Fetching from tid ' + tid);

        self.cexio.trades({since: tid},
          function(err, trades) {
            if(err || !trades || trades.length === 0)
              self.retry(self.getTrades, args);
            else {
              trades= trades.reverse();
              _.forEach(trades, function(trade) {
                // convert to int
                trade.amount= Number(trade.amount);
                trade.price= Number(trade.price);
                trade.tid= Number(trade.tid);
                trade.date= Number(trade.date);
                db.insert(trade);
              });
            }
            callback();
        });
      });
    },
    function(callback) {
      if(!since) {
        since= new Date().getTime() * 1000;
        since-= (10 * 1000 * 1000);
      }
      since= Math.floor(since / 1000 / 1000);
      log.debug('fetching since ' + since);

      db.find({'date': {$gte: since}}, function(err, docs) {
        docs= _.sortBy(docs, 'tid');
        // log.debug(self.name, docs);
        if(!docs || docs.length === 0)
          self.retry(self.getTrades, args);
        callback(null, docs);
      });
    }
  ], function(err, result) {
    if(err) return log.error(self.name, 'error: ' + err);
    callback(result);
  });



  // let the db reflect the latest trades from cex.io
  // db.find({}, function(err, docs) {
  //   console.log(_.max(docs, 'tid'));
  //   if(!docs || docs.length === 0)
  //     last_tid= 263000;
  //   else
  //     last_tid= _.max(docs, 'tid').tid;

  //   next_tid= 1 + last_tid;

  //   var args= _.toArray(arguments);
  //   log.debug(self.name, 'Fetching from txid ' + next_tid);
  //   self.cexio.trades({since: next_tid},
  //     function(err, trades) {
  //       if(err || !trades || trades.length === 0)
  //         return self.retry(self.getTrades, args);
  //       // cex.io deliver them in desc order
  //       trades= trades.reverse();
  //       _.forEach(trades, function(trade) {
  //         // log.debug(self.name, 'storing tid ' + trade.tid);
  //         db.insert(trade);
  //       });

  //       db.find({date: {$gt: (since / 1000)}}, function(err, docs)) {
  //       }

  //       db.find({}, function(err, docs) {});
  //   }, this);
  // });


  // if(since && !_.isNumber(since))
  //   since= 263000;
  // else
  //   since= this.next_tid;

  // var next_tid= 0;
  // //console.log('fetching since (incl.) tid:' + since);

  // this.cexio.trades({since: since}, _.bind(function(err, trades) {
  //   if(err || !trades)
  //     return this.retry(this.getTrades, args);
  //   if(trades.length === 0)
  //     return this.retry(this.getTrades, args);
  //   // remember, where we are for the next fetch
  //   this.next_tid= ++(trades[0].tid);
  //   // cex.io returns descending trade list
  //   callback(trades.reverse());
  // }, this));
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

Trader.prototype.retry = function(method, args) {
  var wait = +moment.duration(10, 'seconds');
  log.debug(this.name, 'returned an error, retrying..');

  var self = this;

  // make sure the callback (and any other fn)
  // is bound to Trader
  _.each(args, function(arg, i) {
    if(_.isFunction(arg))
      args[i] = _.bind(arg, self);
  });

  // run the failed method again with the same
  // arguments after wait
  setTimeout(
    function() { method.apply(self, args) },
    wait
  );
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
