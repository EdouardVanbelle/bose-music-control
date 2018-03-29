'use strict';

const request = require('request');
const WebSocketClient = require('websocket').client;

const EventEmitter = require('events');

const xml2js = require('xml2js'); //FIXME:what about UTF8 ?
const xmlParser = xml2js.Parser();

const xmlBuilder = require('xmlbuilder');

const servicesByName  = {};
const servicesByMac   = {};


// ------------------------------------------------------------------------------------------

class BoseSoundTouch extends EventEmitter {

	/*
	 *
	 */
	constructor( name, ip, mac, model, port) {

		super(); 

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

		this.soundTouchVersion = null;
		this._ws = null;

		//tip to avoid this property being visible in JSON 
		Object.defineProperty( this, '_ws', { writable: true, enumerable: false });
	}

	/*
	 *
	 */
	register() {
  		console.log( this + " registering new device");
		servicesByMac[  this.mac  ] = this;
		servicesByName[ this.name ] = this;
	}

	/*
	 *
	 */
	unregister() {
  		console.log( this + " unregistering device");
		delete servicesByMac[  this.mac  ];
		delete servicesByName[ this.name ];
	}

	static lookup( key) {
		if ((key.length == 12) && (key in servicesByMac))
			return servicesByMac[key];

		if (key in servicesByName)
			return servicesByName[key];

		return null; // not found
	}

	static registered() {
		return Object.values( servicesByMac);
	}

	/*
	 *
	 */
	toString() {
		return this.name.padEnd( 20)+" ("+this.mac+")";
	}

	/*
	 *
	 */
	parseConnectionState( message) {
		var current = this;

		//simplify
		message = message.$;

		//store it
		this.connection = message;
	}

	/*
	 *
	 */
	parseVolumeState( message) {
		var current = this;

		//simplify
		message = message.volume;
		if( Array.isArray( message)) { 
			message = message.shift();
		}

		current.volume = {
			current : message.targetvolume[0],
			mute    : (message.muteenabled[0] == "true")
		};

		console.log( current+( current.volume.mute ? " is mute" : " current volume "+current.volume.current));
	}

	/*
	 *
	 */
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

	parseZone( message) {
		var current = this;

		//simplify
		message = message.zone;
		if( Array.isArray( message)) { 
			message = message.shift();
		}

		if( (message === null) || (message === ''))
		{
			console.log(current+' is standalone (no zone)')

			current.zone = {};
			current.zone.isSlave      = false;
			current.zone.isMaster     = false;
			current.zone.isStandalone = true;
			current.zone.slaves       = [];
			current.zone.master       = null;
		}
		else {

			var mastermac = message.$.master;

			if( mastermac == current.mac)
			{

				current.zone = {};
				current.zone.isSlave      = false;
				current.zone.isMaster     = true;
				current.zone.isStandalone = false;
				current.zone.slaves       = [];
				current.zone.master       = mastermac;

				console.log( current+" is master zone");

				for( var i=0; i<message.member.length; i++) {
					var membermac = message.member[i]._;
					if( membermac == current.mac) continue; // ignore himelf

					console.log( current+ " got member "+ this.lookup( membermac));

					current.zone.slaves.push( membermac);
				}
			}
			else
			{
				console.log( current+" is slave zone of "+ this.lookup( mastermac));

				current.zone = {};
				current.zone.isSlave      = true;
				current.zone.isMaster     = false;
				current.zone.isStandalone = false;
				current.zone.slaves       = [];
				current.zone.master       = mastermac;
			}

		}
/*
		ose-Salon-Rdc (04A316E14903) received zoneUpdated notification
		{ '$': { master: '04A316E14903' },
		  member: [ 
		  	{ _: '04A316E14903', '$': [Object] },
		  	{ _: 'A0F6FD3D536C', '$': [Object] } 
		  ] }
		Bose-Cuisine (A0F6FD3D536C) received zoneUpdated notification
		{ '$': { master: '04A316E14903', senderIPAddress: '192.168.2.246', senderIsMaster: 'true' },
		  member: [ { _: 'A0F6FD3D536C', '$': [Object] } ] }
*/
	}



	/*
	 *
	 */
	parseNowPlaying( message) {
		var current = this;

		//simplify
		message = message.nowPlaying;
		if( Array.isArray( message)) { 
			message = message.shift();
		}

		//console.log( message);
		try{
			current.playing = {};
			for( var key in message)
			{
				if (!Array.isArray( message[key])) continue;
				var data = message[key][0];
				if( (data === null) || (typeof(data) === 'string') || (typeof(data) === 'number'))
				{
					current.playing[key] = data;
				}
				else if( (typeof( data) === 'object') && ('_' in data))
				{
					current.playing[key] = data._;
				}
			}
			/*
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
			//*/

			if ('time' in message) {
				current.playing.time        = message.time[0]._;
				current.playing.totalTime   = message.time[0].$.total;
			}


		}
		catch( e) {
			console.log( e);
			console.log( message);
			current.playing = { };
		}

		var playStatus = (('playStatus' in current.playing) ? current.playing.playStatus : "NONE");
		var source     = "ERROR";

		try { source = message.$.source;          } catch( e) { console.log(e); console.log( message) }

		var powerOn    = ((source != "STANDBY") && (source != "INVALID_SOURCE"));

		//  powerOn = ( playStatus == "PLAY_STATE" || playStatus == "BUFFERING_STATE" || playStatus == "PAUSE_STATE" || playStatus == "INVALID_PLAY_STATUS")

		var playing = ("track" in current.playing ? ( current.playing.track +" (from: "+current.playing.artist+")" ) : ( "stationName" in current.playing ? current.playing.stationName : null));
		console.log( current+" source: "+source+", play status: "+playStatus+", playing: "+playing);

		current.source = source;

		//fire event
		if ( current.powerOn !== powerOn) {
			current.powerOn = powerOn;

			this.emit( 'powerChange', current);
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

	/*
	 *
	 */
	checkWebSocket() {
		var selff = this;
		if ( this._ws === null) return null;
		console.log( this+" connected: "+this._ws.connected);
		return this._ws.connected;
	}

	/*
	 *
	 */
	listen() {

	    var client = new WebSocketClient({ 
		keepalive: true, 
		useNativeKeepalive: false, // will ping() server
		keepaliveInterval: 60000,  // ping each 1 min

		dropConnectionOnKeepaliveTimeout: true, 
		keepaliveGracePeriod: 2000
	    });

	    var name = this.name;
	    var ip = this.ip;
	    var current = this;

	    client.on('connect', function( connection) {

		console.log( current + " websocket connected");
	    	current._ws = connection;
		    
		//client.socket.setKeepAlive(true); //hack no more required due to keepalive
		/*
		connection.on('pong', function(data) {
		    console.log( current + "websocket pong");
		});
		*/

		connection.on('error', function(error) {
		    console.log( current + " websocket error: " + error.code);
		});

		connection.on('close', function() {
		    console.log( current + " websocket lost");
		    current.__ws = null; //cleanup
		    setTimeout( 
			    function() { 
				    console.log( current+" try to reconnect websocket "); 
				    current.sync(); 
				    //because was blind 
				    current.listen(); 
			    }, 
			    10000
		    ); 
			//FIXME: is the bose device still up ?
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
				else if ('userInactivityUpdate' in data) {
					// ignore (message from interface)
					// <userInactivityUpdate deviceID="A0F6FD51A816" />
					console.log( current +" received userInactivityUpdate notification" );
				}
				else if ('errorUpdate' in data) {

					console.log( current +" received errorUpdate notification" );
					console.log( message.utf8Data);
					/*
					 <errorUpdate deviceID="04A316E14903"><error value="1315" name="MUSIC_SERVICE_UNPLAYABLE_TRACK" severity="Unknown">kSpErrorContextFailed - Unable to read all tracks from the playing context. Playback of the Spotify context (playlist, album, artist, radio, etc) will stop early because eSDK is unable to retrieve more tracks. This could be caused by temporary communication or server problems, or by the underlying context being removed or shortened during playback (for instance, the user deleted all tracks in the playlist while listening.)</error></errorUpdate>
					 */
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
						else if( key === 'volumeUpdated') {
							// <updates deviceID="04A316E14903"><volumeUpdated><volume><targetvolume>44</targetvolume><actualvolume>44</actualvolume><muteenabled>false</muteenabled></volume></volumeUpdated></updates>
							current.parseVolumeState( finalMessage);
						}

						else if( key === 'nowSelectionUpdated') {
							// ignored
							// <updates deviceID="04A316E14903"><nowSelectionUpdated><preset id="1"><ContentItem source="INTERNET_RADIO" location="4712" sourceAccount="" isPresetable="true"><itemName>Studio Brussel</itemName><containerArt /></ContentItem></preset></nowSelectionUpdated></updates>
						}
						else if( key === 'sourcesUpdated') {
							// ignored
							// <updates deviceID="04A316E14903"><sourcesUpdated /></updates>
						}
						else if( key === 'recentsUpdated') {
							// ignored
							// updates deviceID="04A316E14903"><recentsUpdated><recents><recent deviceID="04A316E14903" utcTime="1522107433" id="2221758507"><contentItem source="SPOTIFY" type="uri" location="spotify:station:user:doudou.djez:cluster:3Cn3adRB3NJUpIpkucwi7G" sourceAccount="doudou.djez" isPresetable="true"><itemName>Daily Mix 5</itemName></contentItem></recent><recent deviceID="04A316E14903" utcTime="1522107340" id="2174867728"><contentItem source="INTERNET_RADIO" location="4712" sourceAccount="" isPresetable="true"><itemName>Studio Brussel</itemName></contentItem></recent><recent deviceID="04A316E14903" utcTime="1521893943" id="2221589651"><contentItem source="SPOTIFY" type="uri" location="spotify:user:spotify:playlist:37i9dQZF1DWZn9s1LNKPiM" sourceAccount="7olx20j62dl29n5u11j3dzpgq" isPresetable="true"><itemName>90s Rock Renaissance</itemName></contentItem></recent><recent deviceID="04A316E14903" utcTime="1521887700" id="2221578653"><contentItem source="SPOTIFY" type="uri" location="spotify:user:spotify:playlist:37i9dQZF1DXb9LIXaj5WhL" sourceAccount="7olx20j62dl29n5u11j3dzpgq" isPresetable="true"><itemName>Bring Back the 90s</itemName></contentItem></recent><recent deviceID="04A316E14903" utcTime="1521885332" id="2215236660"><contentItem source="SPOTIFY" type="uri" location="spotify:station:user:doudou.djez:cluster:7w4s5bpD2IzVoe4tE9lFh3" sourceAccount="doudou.djez" isPresetable="true"> ....
						}
						else if( key === 'zoneUpdated') {

							current.parseZone( finalMessage);
							
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

	/*
	 *
	 */
	end() {
		if( this._ws === null) return;
		this._ws.close();
		this._ws = null;
	}



	/*
	 *
	 */
	_get( command, handler) {
	  var bose_url = "http://" + this.ip + ":" + this.port + '/' + command;
	  request ( { url : bose_url }, handler);
	}

	/*
	 *
	 */
	_post( command, xml, handler) {
	  var bose_url = "http://" + this.ip + ":" + this.port + '/' + command;
	 
	  var options = { 
		  'url' :         bose_url,
		  'content-type': 'application/xml', 
		  'body':         xml.end({ pretty: true})
	  };
	  request.post( options, handler);
	}

	/*
	 *
	 */
	sync() {

	  var current = this;

	/*
	  this._get( 'bassCapabilities', function(err, res, body) {
	    if (err) { return console.log( err); }
	    console.log( current+" "+body);
	  } );
	  */


	  this._get( 'now_playing', function(err, res, body) {
	    if (err) { return console.log( err); }

	    xmlParser.parseString(body, function (err, result) {

		if (err) { return console.log( err); }

		current.parseNowPlaying( result);

	    })

	  })
  	  this.volume();
  	  this.getZone();
	}

	/*
	 *
	 */
	getInfo( handler) {

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

	/*
	 *
	 */
	getZone( handler) {
	  var current = this;
	  this._get( 'getZone', function(err, res, body) {
	    if (err) { return console.log( err); }
	    xmlParser.parseString(body, function (err, zone) {
	      if (err) { return console.log( err); }
		    current.parseZone( zone);
	    });
	  });
	}

	/*
	 *
	 */
	volume( handler) {
	  var current = this;
	  this._get( 'volume', function(err, res, body) {
	    if (err) { return console.log( err); }
	    xmlParser.parseString(body, function (err, json) {
	      if (err) { return console.log( err); }
		    current.parseVolumeState( json);
	    });
	  });
	}

	/*
	 *
	 */
	_zone( slaves) {
	  var xml = xmlBuilder.create('zone', {version: '1.0', encoding: 'UTF-8'})
			   .att( 'master', this.mac)

	  slaves.forEach( function( slave) {
		xml = xml.ele('member', {"ipaddress": slave.ip }, slave.mac)
	  });
	  
	  return xml;

	}

	/*
	 *
	 */
	setZone( slaves, handler) {
	  this._post( 'setZone', this._zone( slaves), function(err, res, body) {
	    if (err) { console.log( err); }
	    handler( res.statusCode == 200);
	  });
	}

	/*
	 *
	 */
	removeZoneSlave( slaves, handler) {
	  this._post('removeZoneSlave', this._zone( slaves), function(err, res, body) {
	    if (err) { return console.log( err); }
	    handler( res.statusCode == 200);
	  });
	}

	/*
	 *
	 */
	addZoneSlave( slaves, handler) {
	  this._post('addZoneSlave', this._zone( slaves), function(err, res, body) {
	    if (err) { return console.log( err); }
	    handler( res.statusCode == 200);
	  });
	}


	/*
	 *
	 */
	key( key, handler) {
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

	/*
	 *
	 */
	setVolume( volume) {
	  var xml = xmlBuilder.create('volume', {version: '1.0', encoding: 'UTF-8'})
			   .txt(volume)

	  var current = this;
	  // presskey
	  current._post( 'volume', xml, function(err, res, body) {
	    if (err) { console.log( err); }
	    handler( res.statusCode == 200);
	  });
	}


}

module.exports = BoseSoundTouch;

