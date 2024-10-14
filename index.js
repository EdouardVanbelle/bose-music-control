'use strict';


require('dotenv').config()

const express = require('express');
const bonjour = require('bonjour')()
const urllib  = require('urllib');
const crypto  = require('crypto');
const mqtt    = require('mqtt');
const winston = require("winston");
const { combine, timestamp, printf, colorize, align } = winston.format;

const BoseSoundTouch = require('./lib/bosesoundtouch');
const Chromecast     = require('./lib/chromecast');
const Denon          = require('./lib/denon-avr');
const Scheduler      = require('./lib/scheduler');
const fs 	         = require('fs');

const process = require('process');
process.title="music-control";


const masterLogger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    //format: process.stdout.isTTY ? winston.format.cli() : winston.format.combine( winston.format.timestamp(), winston.format.json()),
    format: combine(
        //colorize({ message: true }),
        //timestamp({
        //    format: 'YYYY-MM-DD hh:mm:ss.SSS A',
        //}),
        //align(),
        //printf((info) => `[${info.timestamp}] ${info.level.padEnd(5, " ")}: ${info.context?.padEnd( 30, " ")} ${info.message}`),
        printf((info) => `${info.level.padStart(5, " ")}: [${info.context?.padEnd( 32, " ")}] ${info.message}`),
    ),
    transports: [new winston.transports.Console]
});

const app = express();


app.set('view engine', 'ejs')
app.set('json spaces', ' ');

var logger = masterLogger.child( { context: "core" });
var httpLogger = masterLogger.child( { context: "HTTP" });
var mqttLogger = masterLogger.child( { context: "mqtt" });
var scheduler = new Scheduler( masterLogger);

app.use(function (req, res, next) {
    var _logger = req.url.startsWith("/api") ? httpLogger.info : httpLogger.debug;
    _logger( { context: `HTTP ${req.ip}`, message: `${req.method} ${req.url} "${req.get('user-agent')}"` });
    next();
});
app.use(express.static('public'));


//default values by security
var defaultConfig = {
	'enabled': false,
	"volume": 50,
	"begin": "00:00",
	"end": "23:59",
	"message":"knock knock"
};

var globalConfig = JSON.parse(fs.readFileSync('config.json', 'utf8'));
var denon = new Denon( process.env.DENON_ADDRESS, masterLogger);

app.get('/', function (req, res) {
   res.render('index', { title: "🎶 Music Control 🎶", boses: BoseSoundTouch.registered(), 'config': globalConfig });
})

app.get("/api/bose", (req, res) => {
  res.json( BoseSoundTouch.registered());
});

app.get("/api/bose/:bose", (req, res) => {

  var bose = BoseSoundTouch.lookup( req.params.bose);
  if (!bose) {
    res.status(400).json( { message: "not found" })
    return
  }

  res.json( bose );
});

function notify( device, evname, customconfig={}) {
    // create independant object (will not alter defaultConfig)
	var config = Object.assign( {}, defaultConfig);

    var _logger = logger.child({context: `notify ${evname}`});

	if (evname == "__custom") {
		//custom notification
		config=customconfig;
	}
	else {
		if( !( evname in globalConfig.notify)) {
			_logger.warn( `${device} unknwon notifcation ${evname}`);
			return false;
		}

		if( '__default' in globalConfig.notify[evname]) {
			config = Object.assign( config, globalConfig.notify[evname].__default);
		}

        var deviceName = device.name;

        if (device instanceof Chromecast) {
            //namespace it
            deviceName += "@cast";
        }

		if( deviceName in globalConfig.notify[evname]) {
			config = Object.assign( config, globalConfig.notify[evname][deviceName]);
		}

		if( !config.enabled) {
			_logger.info( `notification ${evname} disabled for ${device}`);
			return false;
		}

		var now = new Date().toTimeString().replace( /^(..:..).*/, "$1"); //keep only hh:mm in local timezone

		if( (now < config.begin) || (now > config.end)) {
			_logger.info( `notification ${evname} is mute for ${device} at this time ${now}`);
			return false;
		}
	}


	_logger.info( `firing notification ${evname} for ${device} with url ${config.url} and volume ${config.volume}`);
	var answer = {};

    if (device instanceof BoseSoundTouch) {

        device.notify( process.env.NOTIF_KEY, config.url, config.volume, config.message, function( err, success, jsonError){
            if( err) {
                _logger.warn(`${device} notifcation error: ${err}`);
                    if ((jsonError != null) && (jsonError.constructor === Object) &&  ('$' in jsonError) && ('name' in jsonError.$)) {
                    _logger.warn(`${device} notify error code: ${jsonError.$.name}`);

                    if ( jsonError.$.name == "HTTP_STATUS_CONFLICT") {
                        if( device.zone.isSlave) {
                            _logger.info( `${device} is a slave, do not redo notification`);
                        }
                        else {
                            setTimeout( function(){ 
                                _logger.info( `${device} retry notification...`);
                                device.notify( process.env.NOTIF_KEY, config.url, config.volume, config.message, function( err, success, jsonError){
                                    if (err) {
                                        _logger.warn(`${device} 2nd notify error: ${err}`);
                                    }
                                    else {
                                        _logger.info(`${device} 2nd notify success`);
                                    }

                                });
                            }, 7000+Math.floor( 1000*Math.random()));
                        }
                    }
                }
            }
            else {
                _logger.info( `${device} notification played`);
            }
        } );
    }
    else if (device instanceof Chromecast) {
        device.notify( config.url, function( err, success) {
            if( err) {
                _logger.warn(`${device} notification error: ${err}`);
                return;
            }
            _logger.warn(`${device} notification succes`);
        } );
    }
    else {
        _logger.warn(`unknown object to notify`);
    }

	return true;

}

//fixme: could save it periodically
var watchdog = { };

app.get("/ping", (req, res) => {
  var now=Math.floor( Date.now() / 1000);
  logger.debug("ping watchdog saved for "+req.ip+ " at "+now)
  var uid=null;
  if ('uid' in req.query)
	uid = req.query.uid;

  watchdog[req.ip] = { 'time':now, 'ua': req.get('user-agent'), 'uid':uid };
  res.json( {});
} );

/* dump watchdog */
app.get("/api/watchdog", (req, res) => {
  //FIXME: should check age
  var now=Math.floor( Date.now() / 1000);
  var result={};
  Object.keys( watchdog).forEach( (key) => {
	  result[key] = { 'last-ping': now - watchdog[key].time, 'ua': watchdog[key].ua, 'uid': watchdog[key].uid };
  });
  res.json( result);
} );


/* dump config */
app.get("/api/config", (req, res) => {
  res.json( globalConfig);
} );


app.get("/api/bose/:bose/custom-notify/:lang/:message", (req, res) => {

	var message = decodeURI( req.params.message);
	var lang    = req.params.lang;

	if (['fr', 'it', 'en'].indexOf(lang) == -1) {
		res.json({ 'error': 'language not supported'})
		return;
	}

	const hash = crypto.createHmac('sha256', message).digest('hex');

	const filename  = [ lang, hash, 'mp3' ].join('.');
	const textfile  = [ lang, hash, 'txt' ].join('.');
	const localmp3  = [ './public/sound/custom', filename].join("/");
	const localtext = [ './public/sound/custom', textfile].join("/");
	const url	= req.protocol + '://' + req.get('host') + '/sound/custom/' + filename;  

	logger.info( 'message "'+message+'" is associated to '+filename);

	var answers=[];

	if (fs.existsSync( localmp3)) {

		const time = new Date();
		try {
			//touch files
			fs.utimesSync(localmp3,  time, time);
			fs.utimesSync(localtext, time, time);
		}
		catch( err) {
			logger.info(err);
		}

		// can play it directly
		if ( req.params.bose == "ALL") {
			  var boses = BoseSoundTouch.registered();
			  for ( var i=0; i < boses.length; i++) {
				answers[ boses[i].name ] = notify( boses[i], '__custom', { url: url, message: message, volume: 50 });
			  }
		}
		else {
			  var bose = BoseSoundTouch.lookup( req.params.bose);
			  if (!bose) {
			    res.status(400).json( { message: "not found" })
			    return
			  }

		   	  answers[ bose.name ] = notify( bose, '__custom', { url: url, message: message, volume: 50 });
		}
	}
	else {
		// FIXME: move this ugly code into a library...
	
		//stupid helper
		fs.writeFile( localtext, message+"\n", (err) => {} );

		var writeStream = fs.createWriteStream( localmp3, { 'encoding': null } );

		// google play, simulate Mplayer user agent
		var options = {
			writeStream: writeStream,
			headers: {
				'User-Agent': 'MPLayer'
			}
		};
		urllib.request( 
			"http://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&q="+encodeURIComponent(message)+"&tl="+lang,
			options, 
			(err, unuseddata, unusedres) => {
				if( err) {
					writeStream.close();
					fs.unlink(filename);
					res.json({ 'filename': filename, 'message': message, 'created':false, 'error':err });
				}
				else {
					writeStream.close();
					// can play it directly
					if ( req.params.bose == "ALL") {
						  var boses = BoseSoundTouch.registered();
						  for ( var i=0; i < boses.length; i++) {
							answers[ boses[i].name ] = notify( boses[i], '__custom', { url: url, message: message, volume: 50 });
						  }
					}
					else {
						  var bose = BoseSoundTouch.lookup( req.params.bose);
						  if (!bose) {
						    res.status(400).json( { message: "not found" })
						    return
						  }

						  answers[ bose.name ] = notify( bose, '__custom', { url: url, message: message, volume: 50 });
				        }

				}
			} 
		);

	}

	res.json( answers);	


} );


app.get("/api/bose/:bose/notify/:evname", (req, res) => { 
    fire( req.params.evname, req.params.bose, function( err, success) {
        if (err) {
            logger.info( err);
            //res.status(400).json( { message : err } );
        }
        else {
            res.json( success);
        }
    });
});

/* kept for compatibility */
app.get("/api/bose/:bose/notify", (req, res) => {
    fire( "default", req.params.bose, function( err, success) {
        if (err) {
            logger.info( err);
            //res.status(400).json( { message : err } );
        }
        else {
            res.json( success);
        }
    });
});

var _lastFired={};
function fire( evname, target, handler) {

  var now = Math.floor( Date.now() / 1000);

  if ((now - _lastFired[evname]) <= 6) {
      //avoid multiple event
      logger.info("event "+evname+" played too recently, ignoring it")
      return handler( null, {});
  }
  _lastFired[evname] = now;


  var answers = {};

  if( ( evname in globalConfig.notify) && ('__webhook' in globalConfig.notify[evname]) ) {
	var i;
	for( i=0; i<globalConfig.notify[evname].__webhook.length; i++) {
		var url=globalConfig.notify[evname].__webhook[i];
        // url is truncated for security
		logger.info( `calling webhook: ${url.slice(0,16)}...`);
		urllib.request( url, (err, data, res) => {
			if( err) {
                handler( "oops: "+err, null);
				return;
			}
			logger.debug( data.toString('utf8'));
		} );
	}
  }

  if ( target == "ALL") {
	  var boses = BoseSoundTouch.registered();
	  for ( var device of boses) {
		answers[ device ] = notify( device, evname);
	  }

      /* currently too agressive (invoke also TV & other devices...)
	  var chromecasts = Chromecast.registered();
	  for ( var device of chromecasts) {
        logger.info( `>>>> ${device}`);
		answers[ device ] = notify( device, evname);
	  }
      */ 

	  handler( null, answers);
	  return;
  }
  else if ( target.endsWith( "@cast")) {
        var realname = target.split("@").shift();
        var chromecast = Chromecast.lookup( realname);
        if (chromecast === null) {
            handler( "not found", null);
            return;
        }
        answers[ chromecast.name] = notify( chromecast, evname);;
  }
  else {
	  var bose = BoseSoundTouch.lookup( target);
	  if (!bose) {
        handler( "not found", null);
	    return
	  }

	  answers[ bose.name ] = notify( bose, evname);
  }

  handler( null, answers);
}

app.get("/api/bose/:bose/play_url/:url", (req, res) => {

  var bose = BoseSoundTouch.lookup( req.params.bose);
  if (!bose) {
    res.status(400).json( { message: "not found" })
    return
  }

  //var url = 'http://ia600604.us.archive.org/6/items/jamendo-007505/01.mp3';
  //var url = 'http://ice1.somafm.com/groovesalad-128-mp3';
  //var url = 'http://192.168.2.168:2000/deejay.mp3';
  var url = req.params.url;
  bose.play_url( url, null, function( err, success) {
    if( err) {
    	res.status(400).json( err);
    }
    else {
    	res.json( success);
    }
  });
});

app.get("/api/bose/:bose/volume/:volume", (req, res) => {

  var bose = BoseSoundTouch.lookup( req.params.bose);
  if (!bose) {
    res.status(400).json( { message: "not found" })
    return
  }

  bose.setVolume( req.params.volume, function( err, success) {
    if( err) {
    	res.status(400).json( err);
    }
    else {
    	res.json( success);
    }
  });
});


app.get("/api/bose/:bose/check", (req, res) => {

  var bose = BoseSoundTouch.lookup( req.params.bose);
  if (!bose) {
    res.status(400).json( { message: "not found" })
    return
  }

  res.json( bose.checkWebSocket() );
});

app.get("/api/bose/:bose/reboot", (req, res) => {

  var bose = BoseSoundTouch.lookup( req.params.bose);
  if (!bose) {
    res.status(400).json( { message: "not found" })
    return
  }

  bose.reboot( function( err, success) {
    if( err) {
    	res.status(400).json( err);
    }
    else {
    	res.json( success);
    }
  });

});


app.get("/api/bose/:bose/sync", (req, res) => {

  var bose = BoseSoundTouch.lookup( req.params.bose);
  if (!bose) {
    res.status(400).json( { message: "not found" })
    return
  }

  res.json( bose.sync() );
});

app.get("/api/bose/:bose/spotify/:track", (req, res) => {

  var bose = BoseSoundTouch.lookup( req.params.bose);
  if (!bose) {
    res.status(400).json( { message: "not found" })
    return
  }

  bose.selectSpotify( req.params.track, null, function( err, success) {
    if( err) {
    	res.status(400).json( { message: err })
    }
    else {
    	res.json( success);
    }
  } );
});

app.get("/api/bose/:bose/radio/:id", (req, res) => {

  var bose = BoseSoundTouch.lookup( req.params.bose);
  if (!bose) {
    res.status(400).json( { message: "not found" })
    return
  }

  bose.selectRadio( req.params.id, function( err, success) {
    if( err) {
    	res.status(400).json( { message: err })
    }
    else {
    	res.json( success);
    }
  } );
});


app.get("/api/bose/:bose/key/:key", (req, res) => {

  var bose = BoseSoundTouch.lookup( req.params.bose);
  if (!bose) {
    res.status(400).json( { message: "not found" })
    return
  }

  bose.key( req.params.key, function( err, success) {
    if( err) {
    	res.status(400).json( { message: err })
    }
    else {
    	res.json( success);
    }
  } );
});

app.get("/api/denon/main/source", (req, res) => {
	denon.call(["SI?"], function( err, answers) {
		if( err) { res.status(400).json({ message: err }); return }
		res.json( answers)
	})
});


app.get("/api/denon/main/volume", (req, res) => {
	denon.call(["MV?"], function( err, answers) {
		if( err) { res.status(400).json({ message: err }); return }
		res.json( answers)
	})
});

app.get("/api/denon/main/volume/:volume", (req, res) => {
	var vol;
	if( req.params.volume == "up" || req.params.volume == "down")
	{
		vol = req.params.volume.toUpperCase();
	}
	else 
	{
		vol = parseInt( req.params.volume);
		if ( isNaN( vol) || (vol < 0) || (vol > 100)) {
			res.status(400).json({ message: "wrong value" })
			return
		}
	}
	denon.call(["MV"+vol], function( err, answers) {
		if( err) { res.status(400).json({ message: err }); return }
		res.json( answers)
	})
});

app.get("/api/denon/main/central", (req, res) => {
	denon.call(["CVC ?"], function( err, answers) {
		if( err) { res.status(400).json({ message: err }); return }
		res.json( answers)
	})
});

app.get("/api/denon/main/central/:volume", (req, res) => {
	var vol;
	if( req.params.volume == "up" || req.params.volume == "down")
	{
		vol = req.params.volume.toUpperCase();
	}
	else 
	{
		vol = parseInt( req.params.volume);
		if ( isNaN( vol) || (vol < 0) || (vol > 100)) {
			res.status(400).json({ message: "wrong value" })
			return
		}
	}
	denon.call(["CVC "+vol], function( err, answers) {
		if( err) { res.status(400).json({ message: err }); return }
		res.json( answers)
	})
});


app.get("/api/denon/z2/volume", (req, res) => {
	denon.call(["Z2?"], function( err, answers) {
		if( err) { res.status(400).json({ message: err }); return }
		res.json( answers)
	})
});

app.get("/api/denon/z2/volume/:volume", (req, res) => {
	var vol;
	if( req.params.volume == "up" || req.params.volume == "down")
	{
		vol = req.params.volume.toUpperCase();
	}
	else 
	{
		vol = parseInt( req.params.volume);
		if ( isNaN( vol) || (vol < 0) || (vol > 100)) {
			res.status(400).json({ message: "wrong value" })
			return
		}
	}
	denon.call(["Z2"+vol], function( err, answers) {
		if( err) { res.status(400).json({ message: err }); return }
		res.json( answers)
	})
});

app.get("/api/bose/:bose/group/:slave", (req, res) => {

  var bose = BoseSoundTouch.lookup( req.params.bose);
  if (!bose) {
    res.status(400).json( { message: "not found" })
    return
  }

  var slave = BoseSoundTouch.lookup( req.params.slave);
  if (!slave) {
    res.status(400).json( { message: "not found" })
    return
  }

  bose.addZoneSlave( [ slave ], function( err, success) {
    if( err) {
    	res.status(400).json( { message: "not found" })
    }
    else {
    	res.json( success);
    }
  });
});



app.get("/api/bose/:bose/ungroup/:slave", (req, res) => {

  var bose = BoseSoundTouch.lookup( req.params.bose);
  if (!bose) {
    res.status(400).json( { message: "not found"  })
    return
  }

  var slave = BoseSoundTouch.lookup( req.params.slave);
  if (!slave) {
    res.status(400).json( { message: "not found" })
    return
  }

  bose.removeZoneSlave( [ slave ], function( err, success) {
    if( err) {
    	res.status(400).json( { message: "not found" })
    }
    else {
    	res.json( success);
    }
  });
});

function autoPowerOffOnBluetooth( bose)
{
    logger.info( `${bose} source changed to ${bose.source}`);
    if (bose.source === 'BLUETOOTH' && bose.connectionStatusInfo?.deviceName === "AT-TT") {
        scheduler.schedule(
            "bose-auto-shutdown",
            function() {
                bose.key( 'POWER', function( err, success) {
                    if( err) {
                        logger.warn( `${bose} poweroff error: ${err}`);
                    }
                    else {
                        logger.info( `${bose} poweredoff`);
                    }
                } );
            },
            2 * 3600 * 1000 // in 2 hours
        );
    }
    else {
        scheduler.cancel("bose-auto-shutdown");
    }
}

function syncDenonOnBosePowerChange( bose)
{
	
    logger.info( `${bose} power changed to ${bose.powerOn}`);

    if( bose.source == "UPDATE") 
    {
        logger.info( bose+" is updating, do not control denon power");
        return;
    }

	if( bose.powerOn)
    {
        // just in case
        scheduler.cancel("denon-auto-shutdown");

        //poweron immediatly denon
        denon.call( ["Z2?"], function( err, answers) {
            if (err) { return logger.warn( err) }
            if( answers.indexOf( "Z2OFF") != -1) {
                logger.info("Switching on Denon")
                denon.call( [ "Z2ON", "Z2AUX1" ] ) ;
                //denon_command( "Z250"); //set volume
            }
            else if( answers.indexOf( "Z2ON") != -1) {
                logger.info("Denon is already powered on")
            }
        });
	}
	else
	{
        //poweroff denon in 5min

        // clean up any potential auto shutdown
        scheduler.cancel("bose-auto-shutdown");

        scheduler.schedule( 'denon-auto-shutdown', function() { 
                denon.call( [ "Z2?" ], function( err, answers) {
                    if (err) { return logger.warn( err) }
                    if( answers.indexOf( "Z2ON") != -1 && answers.indexOf( "Z2AUX1") != -1) {
                        logger.info("Denon is on AUX1, switching it off")
                        denon.call( [ "Z2OFF" ] );
                    }
                })
            }, 
            5*60*1000
        );
	}
}

    /* possible action from mqtt2zigbee
        ""       // notification
        "press" 
        "off" 
        "release" 
        "on"     // single hit from philips
        "single" // single hit from sonoff
        "hold"   // long press from philips
        "long"   // long press from sonoff

        "brightness_move_up" // long press up from ikea
        "brightness_move_down" // long press down from ikea
        "brightness_stop" // on release up or down
        
    */

if ("zigbee" in globalConfig) {
    //load zigbee config
    var mqttClient = mqtt.connect( globalConfig.zigbee.server,{clientId:"bose-control"});

    mqttClient._retry = 0;
    mqttClient.on("connect", function() {
        mqttClient._retry = 0;

        for( var topic in globalConfig.zigbee.topics) { 
            
            var _logger = mqttLogger.child( { context: `mqtt: ${topic.split("/").pop()}` });
            mqttClient.subscribe( topic, function( err) {
                if (err) {
                    _logger.warn("Zigbee2mqtt Unable to subscribe on topic: ", err)
                    return
                }
            });
            _logger.info(`Zigbee2mqtt subscribed to: ${topic}`)
        }
    });

    mqttClient.on("error",function(error){
        //will retry each sec, log only once
        if (mqttClient._retry == 0) {
            mqttLogger.warn("failed to connect to mqtt: ", error);
            mqttClient._retry = 1;
        }
    });

    mqttClient.on("message", function( topic, payload, paquet) {

        var _logger = mqttLogger.child( { context: `mqtt: ${topic.split("/").pop()}` });

        if (!topic in globalConfig.zigbee.topics) {
            _logger.warn(`Warning, not supposed to receive a message from topic ${topic}`);
            return;
        }

        if (topic.endsWith('/action')) {
            //old format
            return;
        }

        var message = JSON.parse( payload);
        var eventMapper = globalConfig.zigbee.topics[topic];

        _logger.debug( `topic:${topic} payload: ${payload}`);

        // scan all events
        for (var eventName in eventMapper) {

            // keep only mapped events
            if (!eventName in message) {
                continue;
            }

            // force string
            var eventValue = String( message[eventName]);

            //check that we have a match
            if (!(eventValue in eventMapper[eventName])) {
                _logger.debug( `ignoring event ${eventName}='${eventValue}' from topic ${topic} (not binded)`);
                continue;
            }

            var eventParam=eventMapper[eventName][eventValue];

            // normalize
            if (typeof(eventParam) === 'string') {
                eventParam = { 
                    action: "notify",
                    name: eventParam,
                }
            }

            if (!("id" in eventParam)) {
                // by default use topic name
                eventParam.id = topic
            }

            _logger.info( `event ${eventName}=${eventValue} received on topic ${topic}, binded to action:${eventParam.action} name:${eventParam.name}`);

            switch (eventParam.action) {

                case "cast":
                case "cast/status":
                    var chromecast = Chromecast.lookup( eventParam.target);
                    if (chromecast === null) {
                        _logger.info(`chromecast ${eventParam.target} is unknown`);
                        break;
                    }
                    chromecast.client.getSessions( function( err, ses) {
                        _logger.info( `chromecast ${eventParam.target} sessions ${JSON.stringify( ses, null, 2)}`);
                    });
                    break;

                case "cast/play":
                case "cast/pause":
                    var chromecast = Chromecast.lookup( eventParam.target);
                    if (chromecast === null) {
                        _logger.info(`chromecast ${eventParam.target} is unknown`);
                        break;
                    }
                    if (!chromecast.player) {
                        _logger.info(`chromecast ${eventParam.target} has no active player`);
                        break;
                    }
                    
                    var handler = function( err, session) {
                        if( err) {
                            _logger.warn( `err ${err}`);
                            return;
                        }
                        _logger.info( `chromecast ${eventParam.target} player state: ${session.playerState}`);
                    };
                    if (eventParam.action === "cast/play") {
                        // request a getStatus to force session sync
                        chromecast.player.getStatus( function( err, session) {
                            if (err) {
                                _logger.warn(`chromecast err: ${err}`);
                                return;
                            }
                            if (!session) {
                                _logger.warn(`chromecast no session`);
                                return;
                            }
                            chromecast.player.play( handler);
                        });
                    }
                    else {
                        // request a getStatus to force session sync
                        chromecast.player.getStatus( function( err, session) {
                            if (err) {
                                _logger.warn(`chromecast err: ${err}`);
                                return;
                            }
                            if (!session) {
                                _logger.warn(`chromecast no session`);
                                return;
                            }
                            chromecast.player.pause( handler);
                        });
                    }
                    break;

                case "cast/notify":
                    //chromecast.play();
                    fire( eventParam.name, eventParam.target, function( err, answer) { 
                        if (err) {
                            logger.info( "event "+eventParam.name+" oops: "+err);
                            return
                        }
                        logger.debug("event "+eventParam.name+" fired: ", answer);
                    });

                    break;
 

                case "cancel":
                    scheduler.cancel( eventParam.id);
                    break;

                case "notify":
                    // function to call
                    var doFire = function() {
                        fire( eventParam.name, "ALL", function( err, answer) { 
                            if (err) {
                                logger.info( "event "+eventParam.name+" oops: "+err);
                                return
                            }
                            logger.debug("event "+eventParam.name+" fired: ", answer);
                        });
                    }

                    if ("after" in eventParam) {
                        scheduler.schedule( eventParam.id, doFire, eventParam.after * 1000);
                    }
                    else {
                        //call immediately function
                        doFire();
                    }

                    break;
                default:
                    _logger.warn( `event ${eventName}=${eventValue} from ${topic} is mapped to an unknown action ${eventParam.action}, please check your configuration`);
            }

        }

    });
}




var chromecast = bonjour.find({ type: 'googlecast' });

chromecast.on("up", function( service) {
	var ip = service.addresses[0];

    var friendlyName = service.txt.fn;
    var model = service.txt.md;
    var id = service.txt.id;

	//logger.info( JSON.stringify( service.txt, null, 2));

	var chromecast = new Chromecast( friendlyName, ip, id, model, masterLogger);
    var previous = Chromecast.lookup( chromecast.id);
    if( previous) {
  	    logger.info( "found previous instance with same id, clean it up");
  	    previous.unregister();  
    }

    if (!chromecast.isNest() ) {
        logger.info(`ignore ${chromecast} device ${chromecast.model} as it is not a Nest device`);
        return;
    }

    chromecast.register();
    chromecast.connect({nestOnly: true});
});

// browse for all http services
var soundtouch = bonjour.find({ type: 'soundtouch' });
soundtouch.on("up", function (service) {

  var ip = service.addresses[0]

  if( ip == null) {
  	logger.warn("Warning: no ip found from mDNS on service "+service.name+", using fallback");
	ip = service.referer.address
  }

  var bose = new BoseSoundTouch( service.name, ip, service.txt.mac, service.txt.model, service.port, masterLogger);

  var previous = BoseSoundTouch.lookup( bose.mac);
  if( previous) {
  	logger.info( "found previous instance with same mac, clean it up");
  	previous.unregister();
  }

  bose.register();

  //connect websocket ( + will sync() )
  bose.connect();
  bose.getInfo();

  if ( bose.name === process.env.BOSE_WIRED_TO_DENON)
  {
     logger.info( `Device ${bose} is wired to denon amplificator`);
     bose.on( 'powerChange', syncDenonOnBosePowerChange);
     bose.on( 'sourceChange', autoPowerOffOnBluetooth);
  }

})

soundtouch.on("down", function (service) {

  var bose = BoseSoundTouch.lookup(service.txt.mac);
  if (! bose) return;

  logger.info( "Unregistering device: " + bose);

  // FIXME: clean up some schedulers ?
  bose.unregister();

})

app.listen(3000, '0.0.0.0', () => {
  logger.info('music control is running on port 3000 !');
});



