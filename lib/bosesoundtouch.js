'use strict';

const request = require('request');
const WebSocketClient = require('websocket').client;

const EventEmitter = require('events');

const xml2js = require('xml2js'); //FIXME:what about UTF8 ?
const xmlParser = xml2js.Parser();

const xmlBuilder = require('xmlbuilder');

const servicesByName  = {};
const servicesByMac   = {};

const MAXRETRY = 4;


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

		this.wsFailure = 0;

		this.soundTouchVersion = null;
		this._ws 		= null;
		this._wsConnector = null;
		this._wsReconnectTimeout = null;

		//tip to avoid this property being visible in JSON 
		Object.defineProperty( this, '_ws',          { writable: true, enumerable: false });
		Object.defineProperty( this, '_wsConnector', { writable: true, enumerable: false });
		Object.defineProperty( this, '_wsReconnectTimeout', { writable: true, enumerable: false });

		this._resetState();
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

		this.end(); // close all connections if necessary

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
	 _resetState() {
		this.powerOn= null;
		this.playStatus = null;
		this.source = null;
		this.playing = {};
		this.volume = {};
		this.zone = {};
		this.accounts = {
			spotify : [],
		}
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
		<?xml version="1.0" encoding="UTF-8" ?>
		<presets>
			<preset id="1" createdOn="1477773521" updatedOn="1477773521"><ContentItem source="INTERNET_RADIO" location="4712" sourceAccount="" isPresetable="true"><itemName>Studio Brussel</itemName><containerArt /></ContentItem></preset>
			<preset id="2" createdOn="1477787715" updatedOn="1499956412"><ContentItem source="INTERNET_RADIO" location="42919" sourceAccount="" isPresetable="true"><itemName>Addict Radio Rock</itemName><containerArt>http://item.radio456.com/007452/logo/logo-42919.jpg</containerArt></ContentItem></preset>
			<preset id="3" createdOn="1477825758" updatedOn="1515342940"><ContentItem source="INTERNET_RADIO" location="3105" sourceAccount="" isPresetable="true"><itemName>RDS Radio Dimensione Suono</itemName><containerArt>http://item.radio456.com/007452/logo/logo-3105.jpg</containerArt></ContentItem></preset>
			<preset id="4" createdOn="1478364097" updatedOn="1510228762"><ContentItem source="INTERNET_RADIO" location="9878" sourceAccount="" isPresetable="true"><itemName>RTBF Classic 21</itemName><containerArt>http://item.radio456.com/007452/logo/logo-9878.jpg</containerArt></ContentItem></preset>
			<preset id="5" createdOn="1477825801" updatedOn="1490182074"><ContentItem source="INTERNET_RADIO" location="1307" sourceAccount="" isPresetable="true"><itemName>France Info</itemName><containerArt>http://item.radio456.com/007452/logo/logo-1307.jpg</containerArt></ContentItem></preset>
			<preset id="6" createdOn="1477825718" updatedOn="1477825718"><ContentItem source="INTERNET_RADIO" location="45753" sourceAccount="" isPresetable="true"><itemName>euronews French</itemName><containerArt /></ContentItem></preset>
			</presets>
		*/
	parsePresets( message) {
		//TODO
	}

	/*
	 *
	 */
		 /*
		 <?xml version="1.0" encoding="UTF-8" ?>
		 <sources deviceID="34151397C788">
			<sourceItem source="AUX" sourceAccount="AUX" status="READY" isLocal="true" multiroomallowed="true">AUX IN</sourceItem>
			<sourceItem source="STORED_MUSIC" sourceAccount="00113202-e97c-0011-7ce9-7ce902321100/0" status="READY" isLocal="false" multiroomallowed="true">nas</sourceItem>
			<sourceItem source="INTERNET_RADIO" status="READY" isLocal="false" multiroomallowed="true" />
			<sourceItem source="BLUETOOTH" status="UNAVAILABLE" isLocal="true" multiroomallowed="true" />
			<sourceItem source="QPLAY" sourceAccount="QPlay1UserName" status="UNAVAILABLE" isLocal="true" multiroomallowed="true">QPlay1UserName</sourceItem>
			<sourceItem source="QPLAY" sourceAccount="QPlay2UserName" status="UNAVAILABLE" isLocal="true" multiroomallowed="true">QPlay2UserName</sourceItem>
			<sourceItem source="UPNP" sourceAccount="UPnPUserName" status="UNAVAILABLE" isLocal="false" multiroomallowed="true">UPnPUserName</sourceItem>
			<sourceItem source="STORED_MUSIC_MEDIA_RENDERER" sourceAccount="StoredMusicUserName" status="UNAVAILABLE" isLocal="false" multiroomallowed="true">StoredMusicUserName</sourceItem>
			<sourceItem source="NOTIFICATION" status="UNAVAILABLE" isLocal="false" multiroomallowed="true" />
			<sourceItem source="SPOTIFY" sourceAccount="7olx20j62dl29n5u11j3dzpgq" status="READY" isLocal="false" multiroomallowed="true">redvalerouge@gmail.com</sourceItem>
			<sourceItem source="SPOTIFY" sourceAccount="doudou.djez" status="READY" isLocal="false" multiroomallowed="true">spotify@edouard.vanbelle.fr</sourceItem>
			<sourceItem source="SPOTIFY" status="UNAVAILABLE" isLocal="false" multiroomallowed="true" />
			<sourceItem source="ALEXA" status="READY" isLocal="false" multiroomallowed="true" />
			<sourceItem source="TUNEIN" status="READY" isLocal="false" multiroomallowed="true" />
		</sources>
		*/
	parseSources( message) {
		var current = this;

		//simplify
		message = message.sources;

		for( var i = 0; i < message.sourceItem.length; i++) {
			var si = message.sourceItem[i];

			//keep only ready source
			if( si.$.status != 'READY')
				continue;

			var name = si._;

			if ( si.$.source == "SPOTIFY" ) {
				console.log( current + " adding SPOTIFY", name, "(", si.$.sourceAccount, ")");
				current.accounts.spotify.unshift( { 'id': si.$.sourceAccount, 'name': name }); //prepend account
			}
			else {
				//ignore other sources for now
				//console.log( name, si.$);
			}

		}


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

					console.log( current+ " got member "+ BoseSoundTouch.lookup( membermac));

					current.zone.slaves.push( membermac);
				}
			}
			else
			{
				console.log( current+" is slave zone of "+ BoseSoundTouch.lookup( mastermac));

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
			current.playing = { 
				skipEnabled:	      false,
				skipPreviousEnabled:  false,
				favoriteEnabled:      false,
				isFavorite:           false
			};
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

				//boolean values
				if( (current.playing[key] == "") && (key.endsWith( 'Enabled') || (key == "isFavorite")))
				{
					current.playing[key] = true;
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
		  <time total="327">310</time>
		  <skipEnabled />
		  <favoriteEnabled />
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

	parseWebsocketPayload( message) {

	   var current = this;

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
						//console.log( message.utf8Data);
						current.parseNowPlaying( finalMessage);

						//Exmaples:
						// <updates deviceID="34151397C788"><nowPlayingUpdated><nowPlaying deviceID="34151397C788" source="SPOTIFY" sourceAccount="doudou.djez"><ContentItem source="SPOTIFY" type="uri" location="spotify:station:user:doudou.djez:cluster:2O8yrE0KuapQw7IQpc7xzy" sourceAccount="doudou.djez" isPresetable="true"><itemName>Daily Mix 4</itemName></ContentItem><track>Kraut 2016</track><artist>De-Phazz</artist><album>Prankster Bride</album><stationName></stationName><art artImageStatus="IMAGE_PRESENT">http://i.scdn.co/image/bcf384d13efa34e715e1b621ecadd323a65a7ea0</art><time total="327">90</time><skipEnabled /><favoriteEnabled /><playStatus>PLAY_STATE</playStatus><shuffleSetting>SHUFFLE_OFF</shuffleSetting><repeatSetting>REPEAT_OFF</repeatSetting><skipPreviousEnabled /><streamType>TRACK_ONDEMAND</streamType><trackID>spotify:track:2bvtq7RQ1J3FBsLUWBztPA</trackID></nowPlaying></nowPlayingUpdated></updates>

						// <updates deviceID="34151397C788"><nowPlayingUpdated><nowPlaying deviceID="34151397C788" source="TUNEIN" sourceAccount=""><ContentItem source="TUNEIN" type="stationurl" location="/v1/playback/station/s9948" sourceAccount="" isPresetable="true"><itemName>franceinfo</itemName><containerArt>http://cdn-radiotime-logos.tunein.com/s9948q.png</containerArt></ContentItem><track></track><artist></artist><album></album><stationName>franceinfo</stationName><art artImageStatus="SHOW_DEFAULT_IMAGE" /><favoriteEnabled /><playStatus>BUFFERING_STATE</playStatus><streamType>RADIO_STREAMING</streamType></nowPlaying></nowPlayingUpdated></updates>
				
						// <updates deviceID="34151397C788"><nowPlayingUpdated><nowPlaying deviceID="34151397C788" source="STORED_MUSIC" sourceAccount="00113202-e97c-0011-7ce9-7ce902321100/0"><ContentItem source="STORED_MUSIC" location="22$9490" sourceAccount="00113202-e97c-0011-7ce9-7ce902321100/0" isPresetable="true"><itemName>Borrowed Arms</itemName></ContentItem><track>03. Borrowed Arms</track><artist>2 Foot Yard</artist><album>Borrowed Arms</album><offset>2</offset><art artImageStatus="SHOW_DEFAULT_IMAGE" /><time total="295">0</time><skipEnabled /><playStatus>PLAY_STATE</playStatus><shuffleSetting>SHUFFLE_OFF</shuffleSetting><repeatSetting>REPEAT_OFF</repeatSetting><skipPreviousEnabled /></nowPlaying></nowPlayingUpdated></updates>
						// XXX: <offset> is the number of the song in album, starting from 0
					}
					else if( key === 'connectionStateUpdated') {
						current.parseConnectionState( finalMessage);
					}
					else if( key === 'volumeUpdated') {
						// <updates deviceID="04A316E14903"><volumeUpdated><volume><targetvolume>44</targetvolume><actualvolume>44</actualvolume><muteenabled>false</muteenabled></volume></volumeUpdated></updates>
						current.parseVolumeState( finalMessage);
					}

					else if( key === 'nowSelectionUpdated') {
						//console.log( message.utf8Data);
						// ignored
						// <updates deviceID="04A316E14903"><nowSelectionUpdated><preset id="1"><ContentItem source="INTERNET_RADIO" location="4712" sourceAccount="" isPresetable="true"><itemName>Studio Brussel</itemName><containerArt /></ContentItem></preset></nowSelectionUpdated></updates>
					}
					else if( key === 'sourcesUpdated') {
						// ignored
						// <updates deviceID="04A316E14903"><sourcesUpdated /></updates>
					}
					else if( key === 'recentsUpdated') {
						// console.log( message.utf8Data);
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
				console.log( current+" Unknown event: ");
				console.log( message.utf8Data);
			}

		})
	   }
	   else {
		 console.log(current+" unrecognized message");
	   }

	}

	/*
	 *
	 */
	_connectWebsocket( ) {
	    var address = "ws://" + this.ip + ":" + '8080';
	    //var address = "ws://" + "192.168.2.168" + ":" + '8080';
	    //var address = "ws://" + "10.1.1.1" + ":" + '8080';
	    //var address = "ws://" + "192.168.2.168" + ":" + '8080';

	    console.log( this+" connecting websocket "+address+" ..."); 
	    this._wsConnector.connect( address, 'gabbo');
	}

	/*
	 *
	 */
	 _reconnectWebsocket() {
	    var current = this;
	    this._ws = null; //cleanup
	    this.wsFailure++;

	    this._resetState();

	    var sec = (2 ** (this.wsFailure + 1));

	    if( this.wsFailure > MAXRETRY)
	    {
	    	console.log( current+" too much failures, use slow retry");
		sec = 300; //each 5 min
		// FIXME: should we unregister this device ?
	    }

	    console.log( current+" schedule reconnection in "+ sec+"s"); 

	    this._wsReconnectTimeout = setTimeout( 
		    function() { 
			    current._connectWebsocket(); 
		    }, 
		    sec * 1000
	    ); 

	 }

	/*
	 *
	 */
	_prepareWebsocket() {

	    var client = new WebSocketClient({ 
		keepalive: true, 
		useNativeKeepalive: false, // will ping() server
		keepaliveInterval: 60000,  // ping each 1 min

		dropConnectionOnKeepaliveTimeout: true, 
		keepaliveGracePeriod: 2000
	    });

	    var current = this;

	    client.on('connect', function( connection) {

		console.log( current + " websocket connected");
	    	current._ws = connection;
		current.wsFailure = 0; //reset failure count

		// potentially lost state, prefer full sync
	    	current.sync();  
		    
		connection.on('error', function(error) {
		    // EHOSTUNREACH, ECONNREFUSED, ETIMEDOUT, ECONNRESET
		    if ( error.code == 'EHOSTUNREACH' ) {
		    	console.log( current + " websocket error, host unreachable");
		    }
		    else {
		    	console.log( current + " websocket error: " + error.code);
		    }
		    //nothing to do, 'close' will be fired if connection is broken

		});

		connection.on( 'close', function() {
		    console.log( current + " websocket lost");
		    current._reconnectWebsocket();
		});

		connection.on('message', function(message) { 
			current.parseWebsocketPayload( message)
		});
	    });

	    client.on('connectFailed', function(error) {
		    // EHOSTUNREACH, ECONNREFUSED, ETIMEDOUT, ECONNRESET
		    console.log( current + " unable to connect websocket: " + error);
		    current._reconnectWebsocket();
	    });


	    this._wsConnector = client;

	}

	/*
	 *
	 */
	connect() {
		this._prepareWebsocket();
		this._connectWebsocket();
	}

	/*
	 *
	 */
	end() {

		console.log( this+ " ending");

		//clean any scheduler
		if (this._wsReconnectTimeout) {
			clearTimeout( this._wsReconnectTimeout);
			this._wsReconnectTimeout = null;
		}

		//close socket (webservice)
		if( this._ws !== null) {;
			this._ws.removeAllListeners( [ 'close' ]); //avoid autoreconnection
			this._ws.close();
			this._ws = null;
		}

		this._resetState();
	}

	/*
	 *	// answer: 200 OK <?xml version="1.0" encoding="UTF-8" ?><status>/speaker</status> on success
	 *	// on error: 200 OK <?xml version="1.0" encoding="UTF-8" ?><Error value="403" name="HTTP_STATUS_FORBIDDEN" severity="Unknown">unsupported device</Error>
	 */
	_checkUpdateSuccess( err, res, body, handler) {
		if (err) { 
			console.log( err); 
			handler( err, null);
			return;
		}

		console.log( res.headers['content-type'])
		console.log( body)

		//console.log( current+" notification answer: "+body)A
		//
		if (! body.match( /^<\?xml/)) {  ///(res.headers['content-type'] != 'text/xml') && (res.headers['content-type'] != 'application/xml')) {
			console.log( "unrecognized content: "+res.headers['content-type'])
			console.log( body)
			handler( "unrecognized content", null);
			return;
		}

		xmlParser.parseString( body, function (err, json) {
			if (err) { 
				console.log( err); 
				handler( "error parsing xml", null);
			}
			if ('Error' in json) {
				handler( json.Error._, null);
			}
			else if ('status' in json) {
				console.log( "success ")
				console.log(json.status)
				var st = json.status;
				if ((typeof( st) == "object") && '_' in st) {
					st = st._
				}
				handler( null, json.status);
			}
			else if ('errors' in json) {
				console.log( "error");
				console.log( json.errors.error[0]._);
				handler( json.errors.error[0]._, null);
			}
			else {
				console.log( "unknown response")
				console.log( json)
				handler( "unknown response", null);
			}
		});
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

	  console.log(this + " calling "+command);
	  var bose_url = "http://" + this.ip + ":" + this.port + '/' + command;
	 
	  var options = { 
		  'url' :         bose_url,
		  'content-type': 'application/xml', 
		  'body':         xml.end({ pretty: true})
	  };

	  request.post( options, (err, res, body) => { this._checkUpdateSuccess( err, res, body, handler) } );
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

	  });
  	  this.getZone( null);
  	  this.getVolume( null);
	  //this.getPresets( null);
	  this.getSources( null);

	  return true;
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
	notify( key, url, handler) {
		var current = this;
		var xml = xmlBuilder.create('play_info', {version: '1.0', encoding: 'UTF-8'})
		xml.ele('app_key', {}, key)
		xml.ele('url',     {}, url)
	        xml.ele('service', {}, 'test')
	        xml.ele('reason',  {}, 'test')
	        xml.ele('message', {}, 'test')
		xml.ele('volume',  {}, 35)

		console.log( this+ " request notification with "+url)

		this._post( 'speaker', xml, handler);
	}


	/*
	 *
	 */
	selectSpotify( uri, account, handler) {
		var current = this;

		if ( account === null) {
			account = this.accounts.spotify[0].id; //pick first account //FIXME should ensure got at least  account
		}

		console.log( this + " request SPOTIFY "+uri+" on account "+account );
		//<ContentItem source="SPOTIFY" type="uri" location="spotify:user:doudou.djez:collection" sourceAccount="doudou.djez" isPresetable="true">
		var xml = xmlBuilder.create('ContentItem', {version: '1.0', encoding: 'UTF-8'});
		xml.att( 'source', 	'SPOTIFY');
		xml.att( 'type', 	'uri');
		xml.att( 'location',	uri); // example: spotify:track:3yH9TwcXxCPlaxCfX5d7MD
		xml.att( 'sourceAccount', account); //FIXME: use correct account

		this._post( 'select', xml, handler);
	}

	/*
	 *
	 */
	selectRadio( radio, handler) {
		var current = this;
		//<ContentItem source="INTERNET_RADIO" location="4712" sourceAccount="" isPresetable="true">
		var xml = xmlBuilder.create('ContentItem', {version: '1.0', encoding: 'UTF-8'});
		xml.att( 'source', 	'INTERNET_RADIO');
		xml.att( 'location',	4712); // 4712 for StudioBruxels
		xml.att( 'sourceAccount',''); 

		this._post( 'select', xml, handler);
	}


	/*
	 *
	 */
	getPresets( handler) {
	  var current = this;
	  this._get( 'presets', function(err, res, body) {
	    if (err) { return console.log( err); }
	    xmlParser.parseString(body, function (err, presets) {
	      if (err) { return console.log( err); }
	      	current.parsePresets( presets)
	    });
	  });
	}


	/*
	 *
	 */
	getSources( handler) {
	  var current = this;
	  this._get( 'sources', function(err, res, body) {
	    if (err) { return console.log( err); }
	    xmlParser.parseString(body, function (err, sources) {
	      if (err) { return console.log( err); }
	      	current.parseSources( sources)
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
	getVolume( handler) {
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
		xml.ele('member', {"ipaddress": slave.ip }, slave.mac)
	  });
	  
	  return xml;

	}

	/*
	 *
	 */
	setZone( slaves, handler) {
	  this._post( 'setZone', this._zone( slaves), handler);
	}

	/*
	 *
	 */
	removeZoneSlave( slaves, handler) {
	  this._post('removeZoneSlave', this._zone( slaves), handler);
	}

	/*
	 *
	 */
	addZoneSlave( slaves, handler) {

	  //hack: call setZone if no zone 
	  if( (typeof( this.zone) == 'object') && this.zone.isMaster) {
	  	//is a master add zones

		//remove already existing slaves
		for( var i = 0; i < slaves.length; i++) {
			if ( this.zone.slaves.indexOf( slaves[i].mac ) != -1) {
				slaves.splice( i, 1);
				i--; //because element has been removed
			}
		}

		if (! slaves.length) {
			handler( "nothing to do", null);
		}
		else {
			this._post('addZoneSlave', this._zone( slaves), handler);
		}
	  }
	  else if( (typeof( this.zone) == 'object') && this.zone.isStandalone) {
	  	//is standalone
	  	this.setZone( slaves, handler);
	  }
	  else {
	  	//oops
	  	handler( "not master nor standalone", null);
	  }
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
	  current._post( 'key', xml, function(err, answer) {
	    if( err) {
		    handler( err, answer)
	    }
	    else {
	    	// now release key
	    	xml.att("state", "release"); 
	    	current._post( 'key', xml, handler);
	    }
	  });
	}

	/*
	 *
	 */
	setVolume( volume, handler) {
	  var xml = xmlBuilder.create('volume', {version: '1.0', encoding: 'UTF-8'})
			   .txt(volume)

	  var current = this;
	  // presskey
	  current._post( 'volume', xml, handler);
	}


}

module.exports = BoseSoundTouch;


