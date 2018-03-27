const dotenv = require('dotenv').config();
const express = require('express');
const app = express();
const crypto = require('crypto');
const cookie = require('cookie');
const nonce = require('nonce')();
const querystring = require('querystring');
const request = require('request');
const WebSocketClient = require('websocket').client;

const test_env = process.env.TEST;

const xml2js = require('xml2js'); //FIXME: what about UTF8 ?
const xmlParser = xml2js.Parser();

const xmlBuilder = require('xmlbuilder');

const net = require('net');

const bonjour = require('bonjour')()

// ------------------------------------------------------------------------------------------

function BoseSoundTouch( name, ip, mac, model, port) {
	this.name   = name;
	this.ip     = ip;
	this.mac    = mac;
	this.model  = model;
	this.port   = port;
	this.info   = null;
	this.powerOn= null;
	this.playStatus = null;
	this.source = null;
	this.playing = {};

	this.eventHandler = {};
	this.soundTouchVersion = null;
	this.ws = null;
}

BoseSoundTouch.prototype.toString = function() {
  	return this.name+" ("+this.mac+")";
}

BoseSoundTouch.prototype.parseConnectionState = function( message) {
	var current = this;

	//simplify
	message = message.$;

	//store it
	this.connection = message;
}

BoseSoundTouch.prototype.parseNowPlaying = function( message) {
	var current = this;

	//simplify
	message = message.nowPlaying;
	if( Array.isArray( message)) { 
		message = message.shift();
	}

	//console.log( message);

	playStatus = "ERROR";
	source     = "INVALID_SOURCE";

	try { source = message.$.source;          } catch( e) {}
	try { playStatus = message.playStatus[0]; } catch( e) {}

	var powerOn    = ((source != "STANDBY") && (source != "INVALID_SOURCE"));

        //  powerOn = ( playStatus == "PLAY_STATE" || playStatus == "BUFFERING_STATE" || playStatus == "PAUSE_STATE" || playStatus == "INVALID_PLAY_STATUS")

	current.playStatus  = playStatus;
	try{
		current.playing = {
			track          : message.track[0],
			artist         : message.artist[0],
			album          : message.album[0],
			art            : message.art[0]._,
			station        : message.stationName[0],
			time           : null,
			totalTime      : null
			//shuffleSetting : message.shuffleSetting[0],
			//repeatSetting  : message.repeatSetting[0],
			//trackID        : message.trackID[0]
		};

		if ('time' in message) {
			current.playing.time        = message.time[0]._;
			current.playing.totalTime   = message.time[0].$.total;
		}


        }
	catch( e) {
		console.log( e);
		current.playing = { };
	}

	console.log( current+" source: "+source+", playing: "+playStatus)
	console.log( current.playing);

	current.source = source;

	//fire event
	if ( current.powerOn !== powerOn) {
		current.powerOn = powerOn;
		if ( typeof( current.eventHandler['powerChange'] ) == "function" ) {
			current.eventHandler['powerChange']( current);
		}
	}

	 /*
	<?xml version="1.0" encoding="UTF-8" ?>
	<nowPlaying deviceID="04A316E14903" source="SPOTIFY" sourceAccount="doudou.djez">
	  <ContentItem source="SPOTIFY" type="uri" location="spotify:user:doudou.djez:collection" sourceAccount="doudou.djez" isPresetable="true">
	    <itemName>My songs</itemName>
	  </ContentItem>
	  <track>Paper Scissors Stone</track>
	  <artist>Portico Quartet</artist>
	  <album>Isla</album>
	  <stationName></stationName>
	  <art artImageStatus="IMAGE_PRESENT">http://i.scdn.co/image/2de187645f5fce8b32d8c4aa4579bfd9b8444aa5</art>
	  <time total="327">310</time><skipEnabled /><favoriteEnabled />
	  <playStatus>PAUSE_STATE</playStatus>
	  <shuffleSetting>SHUFFLE_ON</shuffleSetting>
	  <repeatSetting>REPEAT_OFF</repeatSetting>
	  <skipPreviousEnabled />
	  <streamType>TRACK_ONDEMAND</streamType>
	  <isFavorite />
	  <trackID>spotify:track:3yH9TwcXxCPlaxCfX5d7MD</trackID>
	</nowPlaying>
	
	...

        <nowPlaying deviceID="04A316E14903" source="INTERNET_RADIO">
	<ContentItem source="INTERNET_RADIO" location="4712" sourceAccount="" isPresetable="true"><itemName>VRT Studio Brussel</itemName><containerArt>http://item.radio456.com/007452/logo/logo-4712.jpg</containerArt></ContentItem>
	<track></track>
	<artist></artist>
	<album></album>
	<stationName>VRT Studio Brussel</stationName>
	<art artImageStatus="IMAGE_PRESENT">http://item.radio456.com/007452/logo/logo-4712.jpg</art>
	<playStatus>PLAY_STATE</playStatus>
	<description>MP3  128 kbps  Brussels Belgium,  Studio BruBel geeft je overdag de beste pop-, rock- en dansmuziek en &apos;s avonds een eigenzinnige selectie van genres en stijlen. Life is Music</description>
	<stationLocation>Brussels Belgium</stationLocation>

	...

        <nowPlaying deviceID="A0F6FD51A816" source="BLUETOOTH" sourceAccount="">
	<ContentItem source="BLUETOOTH" location="" sourceAccount="" isPresetable="false">
	  <itemName>Edouard</itemName>
	</ContentItem>
	<track>Operaz</track>
	<artist>Chinese Man</artist>
	<album>Operaz</album>
	<stationName>Edouard</stationName>
	<art artImageStatus="SHOW_DEFAULT_IMAGE" />
	<skipEnabled />
	<playStatus>PLAY_STATE</playStatus>
	<skipPreviousEnabled />
	<genre></genre>
	<connectionStatusInfo status="CONNECTED" deviceName="Edouard" />
	</nowPlaying>
	*/

}


BoseSoundTouch.prototype.listen = function() {

    var client = new WebSocketClient();
    //this.ws = client;
    var name = this.name;
    var ip = this.ip;
    var current = this;

    client.on('connect', function(connection) {
	//console.log( name + " websocket connected");

        connection.on('error', function(error) {
            console.log( name + error.toString());
        });
        connection.on('close', function() {
            console.log( name + " websocket lost");
        });
        connection.on('message', function(message) {

	 if (message.type === 'utf8') {
	 	xmlParser.parseString( message.utf8Data, function( err, data) {
			if ( err) return;
			if ('SoundTouchSdkInfo' in data) {
				//Greetings, store sound touch SDK version
				current.soundTouchVersion = data.SoundTouchSdkInfo.$.serverVersion;
				if( current.soundTouchVersion != "4")
				{
					console.log("Warning: unknown SDK version "+current.soundTouchVersion);
				}
				return; // ignore
			}
			else if ('userActivityUpdate' in data) {
				// ignore (message from interface)
				// <userActivityUpdate deviceID="04A316E14903" />
				console.log( current +" received userActivityUpdate notification" );
			}
			else if ('updates' in data) {

				for ( var key in data.updates) {
					if( key === "$") continue;
					var finalMessage = data.updates[ key][0];

					console.log( current +" received "+key+" notification" );

					//should scheddule an event
					if( key === 'nowPlayingUpdated') {
						current.parseNowPlaying( finalMessage);
					}
					else if( key === 'connectionStateUpdated') {
						current.parseConnectionState( finalMessage);
					}
					else if( key === 'nowSelectionUpdated') {
						// ignored
						// <updates deviceID="04A316E14903"><nowSelectionUpdated><preset id="1"><ContentItem source="INTERNET_RADIO" location="4712" sourceAccount="" isPresetable="true"><itemName>Studio Brussel</itemName><containerArt /></ContentItem></preset></nowSelectionUpdated></updates>
					}
					else if( key === 'recentsUpdated') {
						// ignored
						// updates deviceID="04A316E14903"><recentsUpdated><recents><recent deviceID="04A316E14903" utcTime="1522107433" id="2221758507"><contentItem source="SPOTIFY" type="uri" location="spotify:station:user:doudou.djez:cluster:3Cn3adRB3NJUpIpkucwi7G" sourceAccount="doudou.djez" isPresetable="true"><itemName>Daily Mix 5</itemName></contentItem></recent><recent deviceID="04A316E14903" utcTime="1522107340" id="2174867728"><contentItem source="INTERNET_RADIO" location="4712" sourceAccount="" isPresetable="true"><itemName>Studio Brussel</itemName></contentItem></recent><recent deviceID="04A316E14903" utcTime="1521893943" id="2221589651"><contentItem source="SPOTIFY" type="uri" location="spotify:user:spotify:playlist:37i9dQZF1DWZn9s1LNKPiM" sourceAccount="7olx20j62dl29n5u11j3dzpgq" isPresetable="true"><itemName>90s Rock Renaissance</itemName></contentItem></recent><recent deviceID="04A316E14903" utcTime="1521887700" id="2221578653"><contentItem source="SPOTIFY" type="uri" location="spotify:user:spotify:playlist:37i9dQZF1DXb9LIXaj5WhL" sourceAccount="7olx20j62dl29n5u11j3dzpgq" isPresetable="true"><itemName>Bring Back the 90s</itemName></contentItem></recent><recent deviceID="04A316E14903" utcTime="1521885332" id="2215236660"><contentItem source="SPOTIFY" type="uri" location="spotify:station:user:doudou.djez:cluster:7w4s5bpD2IzVoe4tE9lFh3" sourceAccount="doudou.djez" isPresetable="true"> ....
					}
					else if( key === 'zoneUpdated') {

						// TODO
						
						/*
						ADD:

						 Bose-Salon-Rdc (04A316E14903) received zoneUpdated notification
						 event not yet treated
						 <updates deviceID="04A316E14903"><zoneUpdated><zone master="04A316E14903"><member ipaddress="192.168.2.188">A0F6FD3D536C</member></zone></zoneUpdated></updates>
						 { zone: [ { '$': [Object], member: [Array] } ] }
						 Bose-Cuisine (A0F6FD3D536C) received zoneUpdated notification
						 event not yet treated
						 <updates deviceID="A0F6FD3D536C"><zoneUpdated><zone master="04A316E14903" senderIPAddress="192.168.2.246" senderIsMaster="true"><member ipaddress="192.168.2.188">A0F6FD3D536C</member></zone></zoneUpdated></updates>
						 { zone: [ { '$': [Object], member: [Array] } ] }

						 REM:

						 <updates deviceID="04A316E14903"><zoneUpdated><zone /></zoneUpdated></updates>
						 { zone: [ '' ] }
						 Bose-Cuisine (A0F6FD3D536C) received nowPlayingUpdated notification
						 Bose-Cuisine (A0F6FD3D536C) source: STANDBY, playing: ERROR
						 {}
						 Bose-Cuisine (A0F6FD3D536C) received zoneUpdated notification
						 event not yet treated
						 <updates deviceID="A0F6FD3D536C"><zoneUpdated><zone /></zoneUpdated></updates>
						 { zone: [ '' ] }
						 Bose-Cuisine (A0F6FD3D536C) received nowPlayingUpdated notification
						 Bose-Cuisine (A0F6FD3D536C) source: STANDBY, playing: ERROR
						 {}

						 */
					}
					else {
						console.log("event not yet treated");
	 					console.log( message.utf8Data);
						console.log( finalMessage);
					}
				}
			}
			else {
				console.log( name+" Unknown event: ");
				console.log( message.utf8Data);
			}

		})
	 }
	 else
	 {
		 console.log(name+" unrecognized message");
	 }

        });
    });

    client.on('connectFailed', function(error) {
	    console.log( name + " "+error);
    });

    client.connect("ws://" + ip + ":" + '8080', 'gabbo');

    return client;
}

BoseSoundTouch.prototype.end = function() {
	if( this.ws === null) return;
	this.ws.close();
	this.ws = null;
}



BoseSoundTouch.prototype._get = function( command, handler) {
  var bose_url = "http://" + this.ip + ":" + this.port + '/' + command;
  request ( { url : bose_url }, handler);
}

BoseSoundTouch.prototype._post = function( command, xml, handler) {
  var bose_url = "http://" + this.ip + ":" + this.port + '/' + command;
 
  var options = { 
	  'url' :         bose_url,
	  'content-type': 'application/xml', 
	  'body':         xml.end({ pretty: true})
  };
  request.post( options, handler);
}

BoseSoundTouch.prototype.sync = function() {

  var current = this;

  this._get( 'now_playing', function(err, res, body) {
    if (err) { return console.log( err); }

    xmlParser.parseString(body, function (err, result) {

        if (err) { return console.log( err); }

	current.parseNowPlaying( result);

    })

  })
}

BoseSoundTouch.prototype.getInfo = function( handler) {

  /*

   <?xml version="1.0" encoding="UTF-8" ?>
   <info deviceID="04A316E14903">
   <name>Bose-Salon-Rdc</name>
   <type>SoundTouch Wireless Link Adapter</type>
   <margeAccountUUID>4695030</margeAccountUUID>
   <components>
     <component><componentCategory>SCM</componentCategory><softwareVersion>18.0.11.41145.2696371 epdbuild.rel_18.x.hepdswbld05.2018-02-16T11:31:46</softwareVersion><serialNumber>U6296054004767121000010</serialNumber></component>
     <component><componentCategory>PackagedProduct</componentCategory><serialNumber>074458F62970473AE</serialNumber></component>
   </components>
   <margeURL>https://streaming.bose.com</margeURL>
   <networkInfo type="SCM"><macAddress>04A316E14903</macAddress><ipAddress>192.168.2.246</ipAddress></networkInfo>
   <networkInfo type="SMSC"><macAddress>F0C77F5DA7F0</macAddress><ipAddress>192.168.2.246</ipAddress></networkInfo>
   <moduleType>sm2</moduleType><
   variant>binky</variant>
   <variantMode>normal</variantMode>
   <countryCode>GB</countryCode><regionCode>GB</regionCode>
   </info>

   <?xml version="1.0" encoding="UTF-8" ?>
   <info deviceID="34151397C788">
   <name>Bose-Salon-Haut</name>
   <type>SoundTouch 10</type>
   <margeAccountUUID>4695030</margeAccountUUID><
   components>
     <component><componentCategory>SCM</componentCategory><softwareVersion>18.0.11.41145.2696371 epdbuild.rel_18.x.hepdswbld05.2018-02-16T11:31:46</softwareVersion><serialNumber>P7310491203739342030120</serialNumber></component>
     <component><componentCategory>PackagedProduct</componentCategory><softwareVersion>18.0.11.41145.2696371 epdbuild.rel_18.x.hepdswbld05.2018-02-16T11:31:46</softwareVersion><serialNumber>069231P73147768AE</serialNumber></component>
   </components>
   <margeURL>https://streaming.bose.com</margeURL>
   <networkInfo type="SCM"><macAddress>34151397C788</macAddress><ipAddress>192.168.2.232</ipAddress></networkInfo>
   <networkInfo type="SMSC"><macAddress>0CB2B72183C0</macAddress><ipAddress>192.168.2.232</ipAddress></networkInfo>
   <moduleType>sm2</moduleType>
   <variant>rhino</variant>
   <variantMode>normal</variantMode>
   <countryCode>GB</countryCode>
   <regionCode>GB</regionCode>
   </info>
   */


  var current = this;
  this._get( 'info', function(err, res, body) {
    if (err) { return console.log( err); }
    xmlParser.parseString(body, function (err, result) {
      if (err) { return console.log( err); }
      current.type = result.info.type[0];
    });
  });
}

BoseSoundTouch.prototype.getZone = function( handler) {
  var current = this;
  this._get( 'getZone', function(err, res, body) {
    if (err) { return console.log( err); }
    xmlParser.parseString(body, function (err, result) {
      if (err) { return console.log( err); }
	    //console.log( body);
	    //TODO
    });
  });
}

BoseSoundTouch.prototype._zone = function( slaves) {
  var xml = xmlBuilder.create('zone', {version: '1.0', encoding: 'UTF-8'})
		   .att( 'master', this.mac)

  slaves.forEach( function( slave) {
	xml = xml.ele('member', {"ipaddress": slave.ip }, slave.mac)
  });
  
  return xml;

}

BoseSoundTouch.prototype.setZone = function( slaves, handler) {
  this._post( 'setZone', this._zone( slaves), function(err, res, body) {
    if (err) { console.log( err); }
    handler( res.statusCode == 200);
  });
}

BoseSoundTouch.prototype.removeZoneSlave = function( slaves, handler) {
  this._post('removeZoneSlave', this._zone( slaves), function(err, res, body) {
    if (err) { return console.log( err); }
    handler( res.statusCode == 200);
  });
}

BoseSoundTouch.prototype.key = function( key, handler) {
  var xml = xmlBuilder.create('key', {version: '1.0', encoding: 'UTF-8'})
                   .att("state", "press")
                   .att("sender", "Gabbo")
		   .txt(key)

  var current = this;
  // presskey
  current._post( 'key', xml, function(err, res, body) {
    if (err) { console.log( err); }
    // now release key
    xml.att("state", "release"); 
    current._post( 'key', xml, function(err, res, body) {
    	if (err) { console.log( err); }
        handler( res.statusCode == 200);
    });
  });
}

BoseSoundTouch.prototype.on = function( eventName, handler) {
	this.eventHandler[ eventName ] = handler;
}


// ------------------------------------------------------------------------------------------

function Denon( ip) {
	this.ip = ip;
}

Denon.prototype.call = function( commands, handler) {

   var answers = [];
   var socket = new net.Socket();
   socket.setTimeout(600);

   socket.on('error', (err) => {
     if( typeof( handler) === 'function')
     {
        handler(null, err);
     }
   });

   socket.on('timeout', () => {

     if( commands.length )
     {
         socket.write( commands.shift()+"\r");
     }
     else {
     	     //console.log( "DEBUG "+answers.toString());
	     //denon.write(command+"\r"); // can keep connection
	     socket.end();

	     if( typeof( handler) === 'function')
	     {
	       setTimeout( function() { handler( answers); }, 200 );
	     }
     }
   });

   socket.connect( 23, this.ip, function() {
     socket.write( commands.shift()+"\r");
   });

   socket.on('data', function(data) {
     answers.push( data.toString().slice(0, -1) ); //remove trailing \n and append to answers
   });

}

// ------------------------------------------------------------------------------------------

var denon = new Denon( 'denon.lan');

var services = {};

var short_name_map = {
	cuisine: "Bose-Cuisine",
	salon:   "Bose-Salon-Rdc",
	enfants: "Bose-Salon-Haut",
	bureau:  "Bose-Bureau"
};

var bose_salon_rdc = null;


app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.get("/api/service", (req, res) => {
  res.json( services);
});

app.get("/api/key/:key", (req, res) => {
  bose_salon_rdc.key( req.params.key, function( success) {
    res.json( success);
  } );
});

app.get("/api/group/:name", (req, res) => {
  if (!( req.params.name in short_name_map)) {
    res.status(400).json( { message: "not found" })
    return
  }
  bose_salon_rdc.setZone( [ services[ short_name_map[ req.params.name ]] ], function( success) {
    res.json( success);
  });
});

app.get("/api/ungroup/:name", (req, res) => {
  if (!( req.params.name in short_name_map)) {
    res.status(400).json( { message: "not found" })
    return
  }
  bose_salon_rdc.removeZoneSlave( [ services[ short_name_map[ req.params.name ]] ], function( success) {
    res.json( success);
  });
});

/*
// browse for all http services
bonjour.find({ type: 'spotify-connect' }, function (service) {
  console.log('-- Found a spotify-connect device: ')
  console.log( service)
})
*/


function syncDenonOnBoseSalonRdcPowerChange( bose)
{
	
        console.log( bose+" powered: "+ bose.powerOn);

	if( bose.powerOn)
        {
	  denon.call( ["Z2?"], function( answers, err) {
            if (err) { return console.log( err) }
            if( answers.indexOf( "Z2OFF") != -1) {
		console.log("Switching on Denon")
		denon.call( [ "Z2ON", "Z2AUX1" ] ) ;
		//denon_command( "Z250"); //set volume
	    }
            else if( answers.indexOf( "Z2ON") != -1) {
		console.log("Denon is on")
            }
	  } );
	}
	else
	{
	  denon.call( [ "Z2?" ], function( answers, err) {
            if (err) { return console.log( err) }
            if( answers.indexOf( "Z2ON") != -1 && answers.indexOf( "Z2AUX1") != -1) {
		console.log("Denon is on AUX1, switching it off")
		denon.call( [ "Z2OFF" ] );
	    }
          })
	}

}



// browse for all http services
var soundtouch = bonjour.find({ type: 'soundtouch' });

soundtouch.on("up", function (service) {


  // format:{"Bose-Salon-Rdc":{"addresses":["192.168.2.246"],"txt":{"description":"SoundTouch","mac":"04A316E14903","manufacturer":"Bose Corporation","model":"SoundTouch"},"name":"Bose-Salon-Rdc","fqdn":"Bose-Salon-Rdc._soundtouch._tcp.local","host":"binky-1436213703.local","referer":{"address":"192.168.2.246","family":"IPv4","port":5353,"size":215},"port":8090,"type":"soundtouch","protocol":"tcp","subtypes":[]}
	//
  var bose = new BoseSoundTouch( service.name, service.addresses[0], service.txt.mac, service.txt.model, service.port);

  services[service.name] = bose;

  console.log( "registering new device "+bose);

  // activate listener (websocket)
  bose.listen();
  bose.getInfo();
  bose.getZone();

  if ( bose.name === "Bose-Salon-Rdc")
  {
     console.log( "Bose-Salon-Rdc found !");
     bose_salon_rdc = bose;
     bose_salon_rdc.on( 'powerChange', syncDenonOnBoseSalonRdcPowerChange);
     bose_salon_rdc.sync();
  }
})

soundtouch.on("down", function (service) {

  if (service.name in services) {
	  var bose = services[service.name];
	  console.log(bose+" left, unregistering it");
	  bose.close();
	  delete services[service.name];
  }
})



app.listen(3000, () => {
  console.log('Example app listening '+test_env+' on port 3000!');
});


