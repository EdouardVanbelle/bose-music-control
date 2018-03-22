const dotenv = require('dotenv').config();
const express = require('express');
const app = express();
const crypto = require('crypto');
const cookie = require('cookie');
const nonce = require('nonce')();
const querystring = require('querystring');
const request = require('request');

const test_env = process.env.TEST;

const xml2js = require('xml2js');
const xmlParser = xml2js.Parser();
const xmlBuilder = require('xmlbuilder');

const net = require('net');

const bonjour = require('bonjour')()

var services = {};;

var short_name_map = {
	cuisine: "Bose-Cuisine",
	salon:   "Bose-Salon-Rdc",
	enfants: "Bose-Salon-Haut",
	bureau:  "Bose-Bureau"
};

var bose_salon_rdc = null;
var last_bose_status = null;
var scheduler = null;



app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.get("/api/service", (req, res) => {
  res.json( services);
});

app.get("/api/key/:key", (req, res) => {
  bose_key( bose_salon_rdc, req.params.key, function( success) {
    res.json( success);
  } );
});

app.get("/api/group/:name", (req, res) => {
  if (!( req.params.name in short_name_map)) {
    res.status(400).json( { message: "not found" })
    return
  }
  bose_setZone( bose_salon_rdc, [ services[ short_name_map[ req.params.name ]] ], function( success) {
    res.json( success);
  });
});

app.get("/api/ungroup/:name", (req, res) => {
  if (!( req.params.name in short_name_map)) {
    res.status(400).json( { message: "not found" })
    return
  }
  bose_removeZoneSlave(  bose_salon_rdc, [ services[ short_name_map[ req.params.name ]] ], function( success) {
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


function denon_command( command, handler)
{
   var denon = new net.Socket();
   var answers = [];
   denon.setTimeout(600);
   denon.on('error', (err) => {
     if( typeof( handler) === 'function')
     {
        handler(null, err);
     }
   });
   denon.on('timeout', () => {
     console.log( "DEBUG "+answers.toString());
     //denon.write(command+"\r"); // can keep connection
     denon.end();

     if( typeof( handler) === 'function')
     {
       setTimeout( function() { handler( answers); }, 200 );
     }
   });
   denon.connect( 23, 'denon.lan', function() {
     denon.write(command+"\r");
   });
   denon.on('data', function(data) {
     //data = data.toString().replace( /\r/g, "\n");
     answers.push( data.toString().slice(0, -1) );
     //denon.end(); // kill client after server's response
   });

}

function checkIfPlaying()
{
     if ( bose_salon_rdc === null) return;

     isPlaying( bose_salon_rdc, function( answer) {

        if (answer === last_bose_status)
        {
	  console.log( "bose is unchanged");
	  return;
	}

        console.log( bose_salon_rdc.name+" playing: "+ answer);

	if( answer)
        {
	  denon_command("Z2?", function( answers, err) {
            if (err) { return console.log( err) }
            if( answers.indexOf( "Z2OFF") != -1) {
		console.log("Switching on Denon")
		denon_command( "Z2ON");
		denon_command( "Z2AUX1");
		//denon_command( "Z250"); //set volume
		last_bose_status = answer;
	    }
            else if( answers.indexOf( "Z2ON") != -1) {
		console.log("Denon is on")
		last_bose_status = answer;
            }
	  } );
	}
	else
	{
	  denon_command("Z2?", function( answers, err) {
            if (err) { return console.log( err) }
            if( answers.indexOf( "Z2ON") != -1 && answers.indexOf( "Z2AUX1") != -1) {
		console.log("Denon is on AUX1, switching it off")
		denon_command( "Z2OFF");
		last_bose_status = answer;
	    }
          })
	}

     } )
}

// browse for all http services
var soundtouch = bonjour.find({ type: 'soundtouch' });

soundtouch.on("up", function (service) {

  console.log('DEBUG Found a Bose SoundTouch device: '+service.name+', IP: '+service.addresses[0]+', port: '+service.port+', mac: '+service.txt.mac) 

  bose_info( service);
  bose_getZone( service);

  // {"Bose-Salon-Rdc":{"addresses":["192.168.2.246"],"txt":{"description":"SoundTouch","mac":"04A316E14903","manufacturer":"Bose Corporation","model":"SoundTouch"},"name":"Bose-Salon-Rdc","fqdn":"Bose-Salon-Rdc._soundtouch._tcp.local","host":"binky-1436213703.local","referer":{"address":"192.168.2.246","family":"IPv4","port":5353,"size":215},"port":8090,"type":"soundtouch","protocol":"tcp","subtypes":[]}
  services[service.name] = {
	  name: service.name,
	  ip:  service.addresses[0],
	  mac: service.txt.mac,
	  model: service.txt.model,
	  port: service.port
  };

  if ( service.name === "Bose-Salon-Rdc")
  {
     console.log( "Bose-Salon-Rdc found !");
     bose_salon_rdc = service;
     checkIfPlaying();
     scheduler = setInterval( checkIfPlaying, 10000);
  }
})

soundtouch.on("down", function (service) {

  console.log('DEBUG Bose SoundTouch device left: '+service.name+', IP: '+service.addresses[0]+', port: '+service.port+', mac: '+service.txt.mac) 

  if ( service.name === "Bose-Salon-Rdc")
  {
     clearInterval( scheduler);
     bose_salon_rdc = null;
  }
})

function bose_info(  service, answerFunction) {
  var baseURL = "http://" + service.addresses[0] + ":" + service.port;
  request( { url : baseURL+"/info" }, function(err, res, body) {
    if (err) { return console.log( err); }
    xmlParser.parseString(body, function (err, result) {
      if (err) { return console.log( err); }
      services[ service.name].type = result.info.type[0];
    });
  });
}

function bose_getZone(  service, answerFunction) {
  var baseURL = "http://" + service.addresses[0] + ":" + service.port;
  request( { url : baseURL+"/getZone" }, function(err, res, body) {
    if (err) { return console.log( err); }
    xmlParser.parseString(body, function (err, result) {
      if (err) { return console.log( err); }
	    //console.log( body);
	    //TODO
    });
  });
}

function bose_setZone(  service, slaves, answerFunction) {

  var baseURL = "http://" + service.addresses[0] + ":" + service.port;
  var xml = xmlBuilder.create('zone', {version: '1.0', encoding: 'UTF-8'})
		   .att( 'master', services[service.name].mac)

  slaves.forEach( function( slave) {
  	console.log( "group zone to "+slave.name)
	xml = xml.ele('member', {"ipaddress": slave.ip }, slave.mac)
  });

  var options = { 
	  'url' :         baseURL+"/setZone",
	  'content-type': 'application/xml', 
	  'body':         xml.end({ pretty: true})
	  		 
  };
  request.post( options, function(err, res, body) {
    if (err) { console.log( err); }
    answerFunction( res.statusCode == 200);
  });
}

function bose_removeZoneSlave(  service, slaves, answerFunction) {
  var baseURL = "http://" + service.addresses[0] + ":" + service.port;
  var xml = xmlBuilder.create('zone', {version: '1.0', encoding: 'UTF-8'})
		   .att( 'master', services[service.name].mac)

  slaves.forEach( function( slave) {
  	console.log( "ungroup zone to "+slave.name)
	xml = xml.ele('member', {"ipaddress": slave.ip }, slave.mac)
  });

  var options = { 
	  'url' :         baseURL+"/removeZoneSlave", 
	  'content-type': 'application/xml', 
	  'body':         xml.end({ pretty: true})
  };
  request.post( options, function(err, res, body) {
    if (err) { return console.log( err); }
    answerFunction( res.statusCode == 200);
  });
}

function bose_key(  service, key, answerFunction) {
  var baseURL = "http://" + service.addresses[0] + ":" + service.port;

  var xml = xmlBuilder.create('key', {version: '1.0', encoding: 'UTF-8'})
                   .att("state", "press")
                   .att("sender", "Gabbo")
		   .txt(key)
  		   .end({ pretty: true});

  var options = { 
	  'url' :         baseURL+"/key", 
	  'content-type': 'application/xml', 
	  'body':         xml
  };
  request.post( options, function(err, res, body) {
    if (err) { console.log( err); }
    answerFunction( res.statusCode == 200);
  });
}



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



function isPlaying(  service, answerFunction) {
  var baseURL = "http://" + service.addresses[0] + ":" + service.port;
  var getURL = baseURL + "/now_playing";

  request( { url : getURL }, function(err, res, body) {
    if (err) { return console.log( err); }

    xmlParser.parseString(body, function (err, result) {

        if (err) { return console.log( err); }

	 /*
	console.log( body);
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

        */
	

	answer     = false;
	playStatus = "ERROR";
	source     = "INVALID_SOURCE";

	try { source = result.nowPlaying.$.source;       } catch( e) {}
	try { playStatus = result.nowPlaying.playStatus; } catch( e) {}

        if( source != "STANDBY" && source != "INVALID_SOURCE" )
        {
          answer = ( playStatus == "PLAY_STATE" || playStatus == "BUFFERING_STATE" || playStatus == "PAUSE_STATE" || playStatus == "INVALID_PLAY_STATUS")
	}

	services[ service.name].on      = answer;
	try{
		services[ service.name].track   = result.nowPlaying.track[0];
		services[ service.name].artist  = result.nowPlaying.artist[0];
		services[ service.name].album   = result.nowPlaying.album[0];
		services[ service.name].art     = result.nowPlaying.art[0]._;
		services[ service.name].station = result.nowPlaying.stationName[0];
        }
	catch( e) {
		services[ service.name].track   = null;
		services[ service.name].artist  = null;
		services[ service.name].album   = null;
		services[ service.name].art     = null;
		services[ service.name].station = null;
	}
	console.log( "DEBUG source: "+source+", playing: "+playStatus)
        answerFunction( answer);
    })

/*
    var actualVolume = $(body).find("actualvolume").first().text();
    console.log("Actual volume of "+ service.name +" : " + actualVolume);
*/
  })
}

app.listen(3000, () => {
  console.log('Example app listening '+test_env+' on port 3000!');
});

