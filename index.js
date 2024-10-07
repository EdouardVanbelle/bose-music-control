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
const Denon          = require('./lib/denon-avr');
const fs 	     = require('fs');

const process = require('process');
process.title="music-control";

//const GCastClient                = require('castv2-client').Client;
//const GCastDefaultMediaReceiver  = require('castv2-client').DefaultMediaReceiver;

const masterLogger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    //format: process.stdout.isTTY ? winston.format.cli() : winston.format.combine( winston.format.timestamp(), winston.format.json()),
    format: combine(
        colorize({ message: true }),
        timestamp({
            format: 'YYYY-MM-DD hh:mm:ss.SSS A',
        }),
        //align(),
        printf((info) => `[${info.timestamp}] ${info.level.padEnd(5, " ")}: ${info.context?.padEnd( 30, " ")} ${info.message}`),
    ),
    transports: [new winston.transports.Console]
});

const app = express();

app.set('view engine', 'ejs')
app.set('json spaces', ' ');

var logger = masterLogger.child( { context: "core" });
var httpLogger = masterLogger.child( { context: "HTTP" });
var mqttLogger = masterLogger.child( { context: "mqtt" });
var schedulerLogger = masterLogger.child( { context: "scheduler" });

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
var scheduler = {};

app.get('/', function (req, res) {
   res.render('index', { title: "🎶 Music Control 🎶", boses: BoseSoundTouch.registered(), 'config': globalConfig });
})

/*
app.get('/', (req, res) => {
  res.send('Hello World!');
});
*/

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

function notify( bose, evname, customconfig={}) {
	var config = Object.assign( defaultConfig);

    var _logger = logger.child({context: `notify ${evname}`});

	if (evname == "__custom") {
		//custom notification
		config=customconfig;
	}
	else {
		if( !( evname in globalConfig.notify)) {
			_logger.warn( bose+" unknown notify "+evname);
			return false;
		}

		if( '__default' in globalConfig.notify[evname]) {
			config = Object.assign( config, globalConfig.notify[evname].__default);
		}
		if( bose.name in globalConfig.notify[evname]) {
			config = Object.assign( config, globalConfig.notify[evname][bose.name]);
		}

		if( !config.enabled) {
			_logger.info( `event ${evname} disabled for ${bose}`);
			return false;
		}

		var now = new Date().toTimeString().replace( /^(..:..).*/, "$1"); //keep only hh:mm in local timezone

		if( (now < config.begin) || (now > config.end)) {
			_logger.info( `event ${evname} is mute for ${bose} at this time ${now}`);
			return false;
		}
	}


	_logger.info( `firing event ${evname} for ${bose} with url ${config.url} and volume ${config.volume}`);
	var answer = {};

	bose.notify( process.env.NOTIF_KEY, config.url, config.volume, config.message, function( err, success, jsonError){
		if( err) {
			_logger.warn(bose+" notify error: "+err);
	                if ((jsonError != null) && (jsonError.constructor === Object) &&  ('$' in jsonError) && ('name' in jsonError.$)) {
			    _logger.warn(bose+" notify error code: "+jsonError.$.name);

				if ( jsonError.$.name == "HTTP_STATUS_CONFLICT") {
					if( bose.zone.isSlave) {
						_logger.info( `${bose} is a slave, do not redo notification`);
					}
					else {
						setTimeout( function(){ 
							_logger.info( bose+" retry notification...");
							bose.notify( process.env.NOTIF_KEY, config.url, config.volume, config.message, function( err, success, jsonError){
								if (err) {
									_logger.warn(bose+" 2nd notify error: "+err);
								}
								else {
									_logger.info(bose+" 2nd notify success");
								}

							});
						}, 7000+Math.floor( 1000*Math.random()));


					}
				}
			}
		}
		else {
			_logger.info( bose + " notification played");
		}
	} );

	return true;

}

//fixme: could save it periodically
var watchdog = { };

app.get("/ping", (req, res) => {
  var now=Math.floor( Date.now() / 1000);
  logger.info("ping watchdog saved for "+req.ip+ " at "+now)
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
      mqttLogger.info("event "+evname+" played too recently, ignoring it")
      return handler( null, {});
  }
  _lastFired[evname] = now;


  var answers = {};

  if( ( evname in globalConfig.notify) && ('__webhook' in globalConfig.notify[evname]) ) {
	var i;
	for( i=0; i<globalConfig.notify[evname].__webhook.length; i++) {
		var url=globalConfig.notify[evname].__webhook[i];
		logger.info( "calling webhook: "+url);
		urllib.request( url, (err, data, res) => {
			if( err) {
                handler( "oops: "+err, null);
				return;
			}

			logger.info( data.toString('utf8'));
		} );
	}
  }


  if ( target == "ALL") {
	  var boses = BoseSoundTouch.registered();
	  for ( var i=0; i < boses.length; i++) {
		answers[ boses[i].name ] = notify( boses[i], evname);
	  }
	  handler( null, answers);
	  return;
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

var denonPowerOffTimer = null;
function syncDenonOnBoseSalonRdcPowerChange( bose)
{
	
    logger.info( bose+" powered: "+ bose.powerOn);

    if( bose.source == "UPDATE") 
    {
        logger.info( bose+" is updating, do not control denon power");
        return;
    }

	if( bose.powerOn)
    {
        //stop any potential poweroff timer
        if (denonPowerOffTimer != null) {
            logger.info("canceling the previous Denon poweroff");
            clearTimeout( denonPowerOffTimer);
            denonPowerOffTimer = null;
        }
        //poweron immediatly denon
        denon.call( ["Z2?"], function( err, answers) {
            if (err) { return logger.info( err) }
            if( answers.indexOf( "Z2OFF") != -1) {
                logger.info("Switching on Denon")
                denon.call( [ "Z2ON", "Z2AUX1" ] ) ;
                //denon_command( "Z250"); //set volume
            }
            else if( answers.indexOf( "Z2ON") != -1) {
                logger.info("Denon is on")
            }
        });
	}
	else
	{
        //poweroff denon in 5min
        logger.info("schedduling a Denon poweroff");
        denonPowerOffTimer = setTimeout( function() { 
                denon.call( [ "Z2?" ], function( err, answers) {
                    if (err) { return logger.info( err) }
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
            mqttClient.subscribe( topic, function( err) {
                if (err) {
                    mqttLogger.warn("Mqtt Unable to subscribe on topic: ", err)
                    return
                }
            });
            mqttLogger.info(`Mqtt subscribed to: ${topic}`)
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

        if (!topic in globalConfig.zigbee.topics) {
            mqttLogger.warn(`Warning, not supposed to receive a message from topic ${topic}`);
            return;
        }

        if (topic.endsWith('/action')) {
            //old format
            return;
        }

        var message = JSON.parse( payload);
        var eventMapper = globalConfig.zigbee.topics[topic];

        mqttLogger.debug( "topic:"+topic+" payload: "+payload);

        // scan all events
        for (var eventName in eventMapper) {

            // keep only mapped events
            if (!eventName in message) {
                continue;
            }

            //force string
            var eventValue = String( message[eventName]);

            //check that we have a match
            if (!(eventValue in eventMapper[eventName])) {
                mqttLogger.info( "topic:"+topic+" ignoring event "+eventName+"='"+eventValue+"' (not binded)");
                continue;
            }

            var evname=eventMapper[eventName][eventValue];

            if (typeof(evname) === 'string') {
                //normalize
                evname = { 
                    "action":"notify",
                    "name":evname,
                }
            }

            if (!("id" in evname)) {
                // by default use topic name
                evname.id = topic
            }

            // FIXME should change evname.name

            mqttLogger.info( "topic:"+topic+" event "+eventName+"="+eventValue+" is binded to action:"+evname.action+" name:"+evname.name);

            if ( evname.action === "cancel") {

                if ( scheduler[evname.id]) {
                    schedulerLogger.info( `${evname.id} is canceled`);
                    clearTimeout( scheduler[evname.id]);
                    scheduler[evname.id] = null;
                }
                else {
                    schedulerLogger.info( `${evname.id} was not scheduled`);
                }

                continue
            }

            if ( evname.action !== "notify") {
                mqttLogger.info( "topic:"+topic+" with "+eventName+ "="+eventValue+" action unkonwn: "+evname.action);
                continue
            }

            if ("after" in evname) {

                if (scheduler[evname.id]) {
                    schedulerLogger.info( `${evname.id} already scheduled`);
                    continue
                }

                schedulerLogger.info( `${evname.id} scheduled in ${evname.after}s`);
                
                scheduler[evname.id] = setTimeout( 
                    function() {
                        schedulerLogger.info( `${evname.id} firing event`);
                        scheduler[evname.id] = null; // clean up
                    
                        fire( evname.name, "ALL", function( err, answer) { 
                            if (err) {
                                logger.info( "event "+evname.name+" oops: "+err);
                                return
                            }
                            logger.info("event "+evname.name+" fired: ", answer);
                        });
                    },
                    evname.after * 1000 
                );

                continue
            }

            fire( evname.name, "ALL", function( err, answer) { 
                if (err) {
                    logger.info( "event "+evname.name+" oops: "+err);
                    return
                }
                logger.info("event "+evname.name+" fired: ", answer);
            });

        }

    });
}



// browse for all http services
var soundtouch = bonjour.find({ type: 'soundtouch' });

/*
var chromecast = bonjour.find({ type: 'googlecast' });

chromecast.on("up", function( service) {
	var ip = service.addresses[0];

	logger.info("googlecast:");
	//logger.info( service);
	logger.info( service.txt.md);
	logger.info( service.txt.fn);
	logger.info( ip);

	if( service.txt.fn != "Mini") {
		return;
	}

		return;
	logger.info( "request for "+service.txt.fn);

	var client = new GCastClient();
	client.connect( ip, function() {
	       client.launch(GCastDefaultMediaReceiver, function(err, player) {
		        var media = {
				// Here you can plug an URL to any mp4, webm, mp3 or jpg file with the proper contentType.
				contentId: 'http://192.168.2.2:3000/sound/doorbell-suona-alla-porta.mp3',
				contentType: 'audio/mp3',
				streamType: 'BUFFERED', // or LIVE
		        };
			
			player.on('status', function(status) {
				logger.info('status broadcast playerState=%s', status.playerState);
			});

			player.load(media, { autoplay: true }, function(err, status) {
				logger.info('media loaded playerState=%s', status);
			});
		} );
	});
});
*/

soundtouch.on("up", function (service) {


  // format:{"Bose-Salon-Rdc":{"addresses":["192.168.2.246"],"txt":{"description":"SoundTouch","mac":"04A316E14903","manufacturer":"Bose Corporation","model":"SoundTouch"},"name":"Bose-Salon-Rdc","fqdn":"Bose-Salon-Rdc._soundtouch._tcp.local","host":"binky-1436213703.local","referer":{"address":"192.168.2.246","family":"IPv4","port":5353,"size":215},"port":8090,"type":"soundtouch","protocol":"tcp","subtypes":[]}

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
     logger.info( "Bose wired to denon found ! It's: " + bose);
     bose.on( 'powerChange', syncDenonOnBoseSalonRdcPowerChange);
  }

})

soundtouch.on("down", function (service) {

  var bose = BoseSoundTouch.lookup(service.txt.mac);
  if (! bose) return;

  logger.info( "Unregistering device: " + bose);
  bose.unregister();

})

app.listen(3000, '0.0.0.0', () => {
  logger.info('music control is running on port 3000 !');
});

//setTimeout( function() { logger.info("XXX simulate connection close"); bose_salon_rdc.end(); }, 30000);


