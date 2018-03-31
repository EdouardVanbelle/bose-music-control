'use strict';

require('dotenv').config()

const express = require('express');
const bonjour = require('bonjour')()

const BoseSoundTouch = require('./lib/bosesoundtouch');
const Denon          = require('./lib/denon-avr');

const app = express();

var denon = new Denon( process.env.DENON_ADDRESS);

app.get('/', (req, res) => {
  res.send('Hello World!');
});

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

app.get("/api/bose/:bose/notify", (req, res) => {

  var bose = BoseSoundTouch.lookup( req.params.bose);
  if (!bose) {
    res.status(400).json( { message: "not found" })
    return
  }

  bose.notify( process.env.NOTIF_KEY, process.env.NOTIF_URL, function( err, success) {
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


app.get("/api/bose/:bose/key/:key", (req, res) => {

  var bose = BoseSoundTouch.lookup( req.params.bose);
  if (!bose) {
    res.status(400).json( { message: "not found" })
    return
  }

  bose.key( req.params.key, function( err, success) {
    if( err) {
    	res.status(400).json( { message: "not found" })
    }
    else {
    	res.json( success);
    }
  } );
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

  bose.setZone( [ slave ], function( success) {
    res.json( success);
  });
});

app.get("/api/denon/volume", (req, res) => {
	denon.call(["Z2?"], function( answers, err) {
		if( err) { res.status(400).json({ message: err }); return }
		res.json( answers)
	})
});

app.get("/api/denon/volume/:volume", (req, res) => {
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
	denon.call(["Z2"+vol], function( answers, err) {
		if( err) { res.status(400).json({ message: err }); return }
		res.json( answers)
	})
});



app.get("/api/bose/:bose/ungroup/:slave", (req, res) => {

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

  bose.removeZoneSlave( [ slave ], function( success) {
    res.json( success);
  });
});

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

  bose.register();

  // activate listener (websocket)
  bose.listen();
  bose.getInfo();

  if ( bose.name === process.env.BOSE_WIRED_TO_DENON)
  {
     console.log( "Bose wired to denon found ! It's: " + bose);
     bose.on( 'powerChange', syncDenonOnBoseSalonRdcPowerChange);
  }

  bose.sync();
})

soundtouch.on("down", function (service) {

  var bose = BoseSoundTouch.lookup(service.txt.mac);
  if (! bose) return;

  bose.close();
  bose.unregister();

})

app.listen(3000, () => {
  console.log('music control is running on 3000!');
});

//setTimeout( function() { console.log("XXX simulate connection close"); bose_salon_rdc.end(); }, 30000);


