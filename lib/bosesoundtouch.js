'use strict';

const urllib = require('urllib');
const WebSocketClient = require('websocket').client;

const EventEmitter = require('events');

const xml2js = require('xml2js'); //FIXME:what about UTF8 ?
const xmlParser = xml2js.Parser();
const util = require('util');

const xmlBuilder = require('xmlbuilder');

const net = require('net');

const servicesByName  = {};
const servicesByMac   = {};

const MAXRETRY = 4;

const AUTOSYNC = 600; // each 10 min will autosync

const namespace = "bose";

// ------------------------------------------------------------------------------------------

//FIXME: add common interface with Chromecast
class BoseSoundTouch extends EventEmitter {

	/*
	 *
	 */
	constructor( name, ip, mac, model, port, logger) {

		super(); 

		this.discoverTime = new Date();

		this.name   = name;
		this.ip     = ip;
		this.mac    = mac;
		this.model  = model;
		this.port   = port;
        this.logger = logger.child({ context: `bose: ${this.name}`});

		this.wsFailure = 0;

		this.soundTouchVersion   = null;
		this._ws 		 = null;
		this._wsConnector        = null;
		this._wsReconnectTimeout = null;
		this._autosyncTimeout    = null;

		//tip to avoid this property being visible in JSON 
		Object.defineProperty( this, '_ws',                 { writable: true, enumerable: false });
		Object.defineProperty( this, '_wsConnector',        { writable: true, enumerable: false });
		Object.defineProperty( this, '_wsReconnectTimeout', { writable: true, enumerable: false });
		Object.defineProperty( this, '_autosyncTimeout',    { writable: true, enumerable: false });

		this._resetState();
	}

	/*
	 *
	 */
	register() {

  		this.logger.info( `registering new soundtouch device ${this.name} (${this.mac}) model: ${this.model}`);
		servicesByMac[  this.mac  ] = this;
		servicesByName[ this.name ] = this;
	}

	/*
	 *
	 */
	unregister() {
  		this.logger.info( "unregistering device");

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

    fullname() {
        return [ this.name, namespace ].join('@')
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
		this.zone = {
			isSlave      : false,
			isMaster     : false,
			isStandalone : true,
			slaves       : [],
			master       : null
		};
		this.accounts = {
			spotify : [],
		}
		this.wifiSignal = "UNKNOWN";
		this.presets = {};
	}


	/*
	 *
	 */
	toString() {
		return String( this.name);
	}

	/*
	 *
	 */
	parseConnectionState( message) {
		var current = this;

		current.wifiSignal = message.$.signal;

		this.logger.debug( "signal status: " + current.wifiSignal);

		// query a network status
		current.networkStatus();

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

		this.logger.debug( current.volume.mute ? "is mute" : "current volume "+current.volume.current);
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
		var presets = message.presets.preset;

		if( presets == null)
			return;

		for ( var i=0; i < presets.length; i++) {
			var preset = presets[i];
			var id = preset.$.id;
			if (! ('ContentItem' in preset)) {
				this.presets[id] = {
					enabled: false,
					name: '',
					art:''
				}
			}
			else {
				this.presets[id] = {
					enabled: true,
					name : ('itemName'     in preset.ContentItem[0] ? preset.ContentItem[0].itemName[0]     : ''),
					art  : ('containerArt' in preset.ContentItem[0] ? preset.ContentItem[0].containerArt[0] : '')
				};
			}
		}
	}

	/*
	 *
	 */
		 /*
		 <?xml version="1.0" encoding="UTF-8" ?>
		 <sources deviceID="0A1Bxxxxxxx1">
			<sourceItem source="AUX" sourceAccount="AUX" status="READY" isLocal="true" multiroomallowed="true">AUX IN</sourceItem>
			<sourceItem source="STORED_MUSIC" sourceAccount="xxxxxxxxxxxxxxxxxxxxx" status="READY" isLocal="false" multiroomallowed="true">nas</sourceItem>
			<sourceItem source="INTERNET_RADIO" status="READY" isLocal="false" multiroomallowed="true" />
			<sourceItem source="BLUETOOTH" status="UNAVAILABLE" isLocal="true" multiroomallowed="true" />
			<sourceItem source="QPLAY" sourceAccount="QPlay1UserName" status="UNAVAILABLE" isLocal="true" multiroomallowed="true">QPlay1UserName</sourceItem>
			<sourceItem source="QPLAY" sourceAccount="QPlay2UserName" status="UNAVAILABLE" isLocal="true" multiroomallowed="true">QPlay2UserName</sourceItem>
			<sourceItem source="UPNP" sourceAccount="UPnPUserName" status="UNAVAILABLE" isLocal="false" multiroomallowed="true">UPnPUserName</sourceItem>
			<sourceItem source="STORED_MUSIC_MEDIA_RENDERER" sourceAccount="StoredMusicUserName" status="UNAVAILABLE" isLocal="false" multiroomallowed="true">StoredMusicUserName</sourceItem>
			<sourceItem source="NOTIFICATION" status="UNAVAILABLE" isLocal="false" multiroomallowed="true" />
			<sourceItem source="SPOTIFY" sourceAccount="spotify-account" status="READY" isLocal="false" multiroomallowed="true">spotify-email-account</sourceItem>
			<sourceItem source="SPOTIFY" sourceAccount="spotify-account" status="READY" isLocal="false" multiroomallowed="true">spotify-email-account</sourceItem>
			<sourceItem source="SPOTIFY" status="UNAVAILABLE" isLocal="false" multiroomallowed="true" />
			<sourceItem source="ALEXA" status="READY" isLocal="false" multiroomallowed="true" />
			<sourceItem source="TUNEIN" status="READY" isLocal="false" multiroomallowed="true" />
		</sources>
		*/
	parseSources( message) {
		var current = this;

		//simplify
		message = message.sources;

		//clean up previous sources
		current.accounts.spotify = [];

		for( var i = 0; i < message.sourceItem.length; i++) {
			var si = message.sourceItem[i];

			//keep only ready source
			if( si.$.status != 'READY')
				continue;

			var name = si._;

			if ( si.$.source == "SPOTIFY" ) {
				this.logger.debug( "adding SPOTIFY", name, "(", si.$.sourceAccount, ")");
				current.accounts.spotify.unshift( { 'id': si.$.sourceAccount, 'name': name }); //prepend account
			}
			else {
				//ignore other sources for now
				//this.logger.debug( name, si.$);
			}

		}


	}

	/*
	 *
	 */
		/*
		ADD:

		Bose-Salon-Rdc (04A3xxxxxxx2) received zoneUpdated notification
		event not yet treated
		<updates deviceID="0A1Bxxxxxxx1"><zoneUpdated><zone master="04A3xxxxxxx2"><member ipaddress="192.168.2.188">0A1Bxxxxxxx1</member></zone></zoneUpdated></updates>
		{ zone: [ { '$': [Object], member: [Array] } ] }
		Bose-Cuisine (0A1Bxxxxxxx1) received zoneUpdated notification
		event not yet treated
		<updates deviceID="0A1Bxxxxxxx1"><zoneUpdated><zone master="04A3xxxxxxx2" senderIPAddress="192.168.2.246" senderIsMaster="true"><member ipaddress="192.168.2.188">0A1Bxxxxxxx1</member></zone></zoneUpdated></updates>
		{ zone: [ { '$': [Object], member: [Array] } ] }

		REM:

		<updates deviceID="0A1Bxxxxxxx1"><zoneUpdated><zone /></zoneUpdated></updates>
		{ zone: [ '' ] }
		Bose-Cuisine (0A1Bxxxxxxx1) received nowPlayingUpdated notification
		Bose-Cuisine (0A1Bxxxxxxx1) source: STANDBY, playing: ERROR
		{}
		Bose-Cuisine (0A1Bxxxxxxx1) received zoneUpdated notification
		event not yet treated
		<updates deviceID="0A1Bxxxxxxx1"><zoneUpdated><zone /></zoneUpdated></updates>
		{ zone: [ '' ] }
		Bose-Cuisine (0A1Bxxxxxxx1) received nowPlayingUpdated notification
		Bose-Cuisine (0A1Bxxxxxxx1) source: STANDBY, playing: ERROR
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
			this.logger.debug( 'is standalone (no zone)')

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

				this.logger.debug( "is master zone");

				for( var i=0; i<message.member.length; i++) {
					var membermac = message.member[i]._;
					if( membermac == current.mac) continue; // ignore himelf

					this.logger.debug( "got member "+ BoseSoundTouch.lookup( membermac));

					current.zone.slaves.push( membermac);
				}
			}
			else
			{
				this.logger.debug( "is slave zone of "+ BoseSoundTouch.lookup( mastermac));

				current.zone = {};
				current.zone.isSlave      = true;
				current.zone.isMaster     = false;
				current.zone.isStandalone = false;
				current.zone.slaves       = [];
				current.zone.master       = mastermac;
			}

		}
/*
		ose-Salon-Rdc (04A3xxxxxxx2) received zoneUpdated notification
		{ '$': { master: '04A3xxxxxxx2' },
		  member: [ 
		  	{ _: '0A1Bxxxxxxx1', '$': [Object] },
		  	{ _: '0A1Bxxxxxxx1', '$': [Object] } 
		  ] }
		Bose-Cuisine (0A1Bxxxxxxx1) received zoneUpdated notification
		{ '$': { master: '0A1Bxxxxxxx1', senderIPAddress: '192.168.2.246', senderIsMaster: 'true' },
		  member: [ { _: '0A1Bxxxxxxx1', '$': [Object] } ] }
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

		//this.logger.info( message);
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
            //this.logger.info( JSON.stringify( message, null, 2));

			if ('time' in message) {
				current.playing.time        = message.time[0]._;
				current.playing.totalTime   = message.time[0].$.total;
			}

            current.connectionStatusInfo = {};

            if ('connectionStatusInfo' in message) {
                //content { status: CONNECTING|CONNECTED|DISCONNECTED, deviceName: string } 
                current.connectionStatusInfo = message.connectionStatusInfo[0].$;
            }
		}
		catch( e) {
			this.logger.debug( e);
			this.logger.debug( message);
			current.playing = { };
		}


        // BUFFERING_STATE | PLAY_STATE | STOP_STATE | PAUSE_STATE
		var playStatus = current.playing?.playStatus || "NONE";
		var source     = "ERROR";

		try { source = message.$.source;          } catch( e) { this.logger.warn(e); this.logger.warn( message) }

		var powerOn    = ((source != "STANDBY") && (source != "INVALID_SOURCE"));

		var playing = ("track" in current.playing ? ( current.playing.track +" (from: "+current.playing.artist+")" ) : ( "stationName" in current.playing ? current.playing.stationName : null));

        // special case 
        // STANDBY | UPDATE | AUX | STORED_MUSIC | INTERNET_RADIO | BLUETOOTH | QPLAY | UPNP | STORED_MUSIC_MEDIA_RENDERER | NOTIFICATION | SPOTIFY | ALEXA | TUNEIN |

        if (source === "LOCAL_INTERNET_RADIO" && "stationName" in current.playing) {
            playing = current.playing.stationName;
        }

        if (current.source !== source || current._playStatus !== playStatus) {
            // only on source changed

            switch( source) {
                case 'STANDBY':
		            this.logger.info( `updated source: ${source} (aka powered-off)`);
                    break;
                case 'UPDATE':
                case 'INVALID_SOURCE':
                case 'AUX':
		            this.logger.info( `updated source: ${source}`);
                    break;
                case 'BLUETOOTH':
		            this.logger.info( `updated source: ${source} play-status: ${playStatus} device-status: ${current.connectionStatusInfo.status} device-name: ${current.connectionStatusInfo.deviceName}`);
                    break;
                default:
                    // STORED_MUSIC | INTERNET_RADIO | QPLAY | UPNP | STORED_MUSIC_MEDIA_RENDERER | NOTIFICATION | SPOTIFY | ALEXA | TUNEIN
		            this.logger.info( `updated source: ${source} play-status: ${playStatus} playing: ${playing}`);
            }

		    current.source = source;
		    current._playStatus = playStatus;
            this.emit( 'sourceChange', current);
        }

		//fire event
		if ( current.powerOn !== powerOn) {
			current.powerOn = powerOn;

			this.emit( 'powerChange', current);
		}

		 /*
		<?xml version="1.0" encoding="UTF-8" ?>
		<nowPlaying deviceID="0A1Bxxxxxxx1" source="SPOTIFY" sourceAccount="spotify-account">
		  <ContentItem source="SPOTIFY" type="uri" location="spotify:user:xxxxxxx:collection" sourceAccount="spotify-account" isPresetable="true">
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

		<nowPlaying deviceID="0A1Bxxxxxxx1" source="INTERNET_RADIO">
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

		<nowPlaying deviceID="0A1Bxxxxxxx1" source="BLUETOOTH" sourceAccount="">
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
		this.logger.debug( this+" connected: "+this._ws.connected);
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
					current.logger.warn("Warning: unknown SDK version "+current.soundTouchVersion);
				}
				return; // ignore
			}
			else if ('userActivityUpdate' in data) {
				// ignore (message from interface)
				// <userActivityUpdate deviceID="0A1Bxxxxxxx1" />
				current.logger.debug( "received userActivityUpdate notification" );
			}
			else if ('userInactivityUpdate' in data) {
				// ignore (message from interface)
				// <userInactivityUpdate deviceID="0A1Bxxxxxxx1" />
				current.logger.debug( "received userInactivityUpdate notification" );
			}
			else if ('errorUpdate' in data) {

				current.logger.debug( "received errorUpdate notification" );
				current.logger.debug( message.utf8Data);
				/*
				 <errorUpdate deviceID="0A1Bxxxxxxx1"><error value="1315" name="MUSIC_SERVICE_UNPLAYABLE_TRACK" severity="Unknown">kSpErrorContextFailed - Unable to read all tracks from the playing context. Playback of the Spotify context (playlist, album, artist, radio, etc) will stop early because eSDK is unable to retrieve more tracks. This could be caused by temporary communication or server problems, or by the underlying context being removed or shortened during playback (for instance, the user deleted all tracks in the playlist while listening.)</error></errorUpdate>
				 */
			}
			else if ('updates' in data) {

				for ( var key in data.updates) {
					if( key === "$") continue;
					var finalMessage = data.updates[ key][0];

					current.logger.debug( "received "+key+" notification" );

					//should scheddule an event
					if( key === 'nowPlayingUpdated') {
						//current.logger.debug( message.utf8Data);
						current.parseNowPlaying( finalMessage);

						//Exmaples:
						// <updates deviceID="0A1Bxxxxxxx1"><nowPlayingUpdated><nowPlaying deviceID="0A1Bxxxxxxx1" source="SPOTIFY" sourceAccount="spotify-account"><ContentItem source="SPOTIFY" type="uri" location="spotify:station:user:spotify-account:cluster:2O8yrE0KuapQw7IQpc7xzy" sourceAccount="spotify-account" isPresetable="true"><itemName>Daily Mix 4</itemName></ContentItem><track>Kraut 2016</track><artist>De-Phazz</artist><album>Prankster Bride</album><stationName></stationName><art artImageStatus="IMAGE_PRESENT">http://i.scdn.co/image/bcf384d13efa34e715e1b621ecadd323a65a7ea0</art><time total="327">90</time><skipEnabled /><favoriteEnabled /><playStatus>PLAY_STATE</playStatus><shuffleSetting>SHUFFLE_OFF</shuffleSetting><repeatSetting>REPEAT_OFF</repeatSetting><skipPreviousEnabled /><streamType>TRACK_ONDEMAND</streamType><trackID>spotify:track:2bvtq7RQ1J3FBsLUWBztPA</trackID></nowPlaying></nowPlayingUpdated></updates>

						// <updates deviceID="0A1Bxxxxxxx1"><nowPlayingUpdated><nowPlaying deviceID="0A1Bxxxxxxx1" source="TUNEIN" sourceAccount=""><ContentItem source="TUNEIN" type="stationurl" location="/v1/playback/station/s9948" sourceAccount="" isPresetable="true"><itemName>franceinfo</itemName><containerArt>http://cdn-radiotime-logos.tunein.com/s9948q.png</containerArt></ContentItem><track></track><artist></artist><album></album><stationName>franceinfo</stationName><art artImageStatus="SHOW_DEFAULT_IMAGE" /><favoriteEnabled /><playStatus>BUFFERING_STATE</playStatus><streamType>RADIO_STREAMING</streamType></nowPlaying></nowPlayingUpdated></updates>
				
						// <updates deviceID="0A1Bxxxxxxx1"><nowPlayingUpdated><nowPlaying deviceID="0A1Bxxxxxxx1" source="STORED_MUSIC" sourceAccount="00113202-e97c-0011-7ce9-7ce902321100/0"><ContentItem source="STORED_MUSIC" location="22$9490" sourceAccount="00113202-e97c-0011-7ce9-7ce902321100/0" isPresetable="true"><itemName>Borrowed Arms</itemName></ContentItem><track>03. Borrowed Arms</track><artist>2 Foot Yard</artist><album>Borrowed Arms</album><offset>2</offset><art artImageStatus="SHOW_DEFAULT_IMAGE" /><time total="295">0</time><skipEnabled /><playStatus>PLAY_STATE</playStatus><shuffleSetting>SHUFFLE_OFF</shuffleSetting><repeatSetting>REPEAT_OFF</repeatSetting><skipPreviousEnabled /></nowPlaying></nowPlayingUpdated></updates>
						// XXX: <offset> is the number of the song in album, starting from 0
					}
					else if( key === 'connectionStateUpdated') {
						current.parseConnectionState( finalMessage);
					}
					else if( key === 'volumeUpdated') {
						// <updates deviceID="0A1Bxxxxxxx1"><volumeUpdated><volume><targetvolume>44</targetvolume><actualvolume>44</actualvolume><muteenabled>false</muteenabled></volume></volumeUpdated></updates>
						current.parseVolumeState( finalMessage);
					}

					else if( key === 'nowSelectionUpdated') {
						//current.logger.debug( message.utf8Data);
						// ignored
						// <updates deviceID="0A1Bxxxxxxx1"><nowSelectionUpdated><preset id="1"><ContentItem source="INTERNET_RADIO" location="4712" sourceAccount="" isPresetable="true"><itemName>Studio Brussel</itemName><containerArt /></ContentItem></preset></nowSelectionUpdated></updates>
					}
					else if( key === 'sourcesUpdated') {
						// ignored
						// <updates deviceID="0A1Bxxxxxxx1"><sourcesUpdated /></updates>
					}
					else if( key === 'recentsUpdated') {
						// current.logger.debug( message.utf8Data);
						// ignored
						// updates deviceID="0A1Bxxxxxxx1"><recentsUpdated><recents><recent deviceID="0A1Bxxxxxxx1" utcTime="1522107433" id="2221758507"><contentItem source="SPOTIFY" type="uri" location="spotify:station:user:spotify-account:cluster:3Cn3adRB3NJUpIpkucwi7G" sourceAccount="spotify-account" isPresetable="true"><itemName>Daily Mix 5</itemName></contentItem></recent><recent deviceID="0A1Bxxxxxxx1" utcTime="1522107340" id="2174867728"><contentItem source="INTERNET_RADIO" location="4712" sourceAccount="" isPresetable="true"><itemName>Studio Brussel</itemName></contentItem></recent><recent deviceID="0A1Bxxxxxxx1" utcTime="1521893943" id="2221589651"><contentItem source="SPOTIFY" type="uri" location="spotify:user:spotify:playlist:37i9dQZF1DWZn9s1LNKPiM" sourceAccount="7olx20j62dl29n5u11j3dzpgq" isPresetable="true"><itemName>90s Rock Renaissance</itemName></contentItem></recent><recent deviceID="0A1Bxxxxxxx1" utcTime="1521887700" id="2221578653"><contentItem source="SPOTIFY" type="uri" location="spotify:user:spotify:playlist:37i9dQZF1DXb9LIXaj5WhL" sourceAccount="7olx20j62dl29n5u11j3dzpgq" isPresetable="true"><itemName>Bring Back the 90s</itemName></contentItem></recent><recent deviceID="0A1Bxxxxxxx1" utcTime="1521885332" id="2215236660"><contentItem source="SPOTIFY" type="uri" location="spotify:station:user:spotify-account:cluster:7w4s5bpD2IzVoe4tE9lFh3" sourceAccount="spotify-account" isPresetable="true"> ....
					}
					else if( key === 'zoneUpdated') {

						current.parseZone( finalMessage);
						
					}
					else {
						current.logger.warn("event not yet treated");
						current.logger.warn( message.utf8Data);
						current.logger.warn( finalMessage);
					}
				}
			}
			else {
				current.logger.warn( "Unknown event: ");
				current.logger.warn( message.utf8Data);
			}

		})
	   }
	   else {
		 current.logger.warn( "unrecognized message");
	   }

	}

	_telnet( command, handler) {

	   var answer = [];
	   var socket = new net.Socket();
    	   var err = null;
	   var seq = 0;
	   socket.setTimeout(6000);

	   var _prompt              = "->";
	   var commandSuccess       = "->OK\n"+_prompt;
	   var commandNotFound      = "Command not found\n"+_prompt;
	   var commandInvalidOption = "Invalid Command Option\n"+_prompt;

	   socket.on('error', (err) => {
	     if( typeof( handler) === 'function')
	     {
		handler(err, null);
	     }
	   });

	   socket.on('timeout', () => {
             err = 'Timeout';
	     socket.end();

	   });

	   socket.on('end', () => {
	     if( typeof( handler) === 'function')
	     {
	       handler( err, answer);
	     }
	   });

	   socket.on('data', function(data) {

	     seq++;
	     if (seq==1) {
		     if (data.indexOf( _prompt) == 0) {
			     socket.write( command+"\n");
		     }
		     else {
			     err = "MissingPrompt";
			     socket.end();
		     }
		     return;
	     }

	     answer += data; 
  	     var index = 0;

	     if ((index = answer.indexOf( commandSuccess)) != -1) {
		     answer = answer.slice( 0, index)
		     socket.end();
	     }
	     else if (( index = answer.indexOf( commandNotFound)) != -1) {
		     err = "CommandNotFound";
		     socket.end();
	     }
	     else if (( index = answer.indexOf( commandInvalidOption)) != -1) {
		     err = "InvalidCommand";
		     socket.end();
	     }

	   });

	   socket.connect( 17000, this.ip);
	}

	/*
	 *
	 */
	_connectWebsocket( ) {
	    var address = "ws://" + this.ip + ":" + '8080';
	    //var address = "ws://" + "192.168.2.168" + ":" + '8080';
	    //var address = "ws://" + "10.1.1.1" + ":" + '8080';
	    //var address = "ws://" + "192.168.2.168" + ":" + '8080';

	    this.logger.debug( "connecting websocket "+address+" ..."); 
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
	    	this.logger.info( "too much failures, use slow retry");
		sec = 300; //each 5 min
		// FIXME: should we unregister this device ?
	    }

	    this.logger.debug( "schedule reconnection in "+ sec+"s"); 

	    this._wsReconnectTimeout = setTimeout( 
		    function() { 
			    current._connectWebsocket(); 
		    }, 
		    sec * 1000
	    ); 

	}


	checkForReboot() {
		//TODO
		//var now = Date.now();
		//if( this.source == 'STANDBY' && this.wifiSignal
	}

	autosync() {

		var current = this;

		this.checkForReboot();

		var sec = Math.floor( Math.random() * 20 + 1) + AUTOSYNC; // AUTOSYNC +/- 10 sec
		
		this.logger.debug( "do sync now & scheddule a sync in "+sec+" sec");
		this.sync();

		this._autosyncTimeout = setTimeout( 
			function() {
				current.autosync();
			}, 
			sec * 1000,
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

            current.logger.debug( "websocket connected");
            current._ws = connection;
            current.wsFailure = 0; //reset failure count

            // potentially lost state, prefer full sync + auto reschedule
	    	current.autosync();  

	    
            connection.on('error', function(error) {
		    // EHOSTUNREACH, ECONNREFUSED, ETIMEDOUT, ECONNRESET
		    if ( error.code == 'EHOSTUNREACH' ) {
		    	current.logger.warn( "websocket error, host unreachable");
		    }
		    else {
		    	current.logger.warn( "websocket error: " + error.code);
		    }
		    //nothing to do, 'close' will be fired if connection is broken

		});

		connection.on( 'close', function() {
		    current.logger.debug( "websocket lost");
		    current._reconnectWebsocket();
		});

		connection.on('message', function(message) { 
			current.parseWebsocketPayload( message)
		});
	    });

	    client.on('connectFailed', function(error) {
		    // EHOSTUNREACH, ECONNREFUSED, ETIMEDOUT, ECONNRESET
		    current.logger.warn( "unable to connect websocket: " + error);
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

		this.logger.debug( "ending");

		//clean any scheduler
		if (this._wsReconnectTimeout) {
			clearTimeout( this._wsReconnectTimeout);
			this._wsReconnectTimeout = null;
		}

		//clean any scheduler
		if (this._autosyncTimeout) {
			clearTimeout( this._autosyncTimeout);
			this._autosyncTimeout = null;
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
	_checkUpdateSuccess( err, data, res, handler) {

		var current = this;

		if (err) { 
			this.logger.info( err); 
			handler( err, null);
			return;
		}

		this.logger.debug( "response content-type: "+res.headers['content-type'])

		this.logger.debug( "notification answer: "+data.toString('utf8') )

		//check that buffer starts with "<xml"
		if (data.toString('utf8', 0, 5) != "<?xml" ) {
			this.logger.warn( "unrecognized content: "+res.headers['content-type'])
			this.logger.warn( ""+data.toString('utf8') )
			handler( { "error": "unrecognized content" }, null);
			return;
		}

		xmlParser.parseString( data, function (err, json) {
			if (err) { 
				current.logger.warn( err); 
				handler( "error parsing xml", null);
			}
			if ('Error' in json) {
				handler( json.Error._, null, json.Error);
			}
			else if ('status' in json) {
				current.logger.debug( "success ")
				current.logger.debug(json.status)
				var st = json.status;
				if ((typeof( st) == "object") && '_' in st) {
					st = st._
				}
				handler( null, json.status);
			}
			else if ('errors' in json) {
				current.logger.warn( "error");
				current.logger.warn( json.errors.error[0]._);
				handler( json.errors.error[0]._, null);
			}
			else if ('s:Envelope' in json) { 
				//case of DLNA
				//<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:SetAVTransportURIResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"></u:SetAVTransportURIResponse></s:Body></s:Envelope>
				current.logger.info("success");
				handler( null, {});
			}
			else {
				current.logger.warn( "unknown response")
				current.logger.warn( json)
				handler( "unknown response", null);
			}
		});
	}



	/*
	 *
	 */
	_get( command, handler) {
	  var bose_url = "http://" + this.ip + ":" + this.port + '/' + command;
	  urllib.request( bose_url, handler);
	}

	/*
	 *
	 */
	_post( command, xml, handler) {

	  this.logger.debug( "calling "+command);
	  var bose_url = "http://" + this.ip + ":" + this.port + '/' + command;
	 
	  var options = { 
		  'method' : 'POST',
		  'headers' : { 
			  'Content-Type': 'application/xml', 
		  },
		  'content':  xml.end({ pretty: true})
	  };

	  urllib.request( bose_url, options, (err, data, res) => { this._checkUpdateSuccess( err, data, res, handler) } );
	}

	/*
	 * DLAN play
	 *
	 * more info: https://books.google.fr/books?id=jc8EZwEuEIoC&pg=PA348&lpg=PA348&dq=dlna+audioItem.audioBroadcast&source=bl&ots=2IE2OBmPUF&sig=MqsvjmB_E8TAMI02nAl2OvNpRBY&hl=en&sa=X&ved=2ahUKEwi3iaa3-ZreAhWsy4UKHawIA7AQ6AEwAnoECAcQAQ#v=onepage&q=dlna%20audioItem.audioBroadcast&f=false
	 */
	play_url( url, title, handler) {

	   if ((title == null) || (title == "")) {
	   	title = url.replace( /.*\//, '');
	   	if (title == "") {
			title = '.oOo.';
		}
	   }

       this.logger.debug( "play via DLNA title: "+title+" url: "+url);

	   var didl = xmlBuilder.create('DIDL-Lite', {}, {}, {headless: true});
	   didl.att( 'xmlns',      'urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/');
	   didl.att( 'xmlns:dc',   'http://purl.org/dc/elements/1.1/');
	   didl.att( 'xmlns:sec',  'http://www.sec.co.kr/'); 
	   didl.att( 'xmlns:upnp', 'urn:schemas-upnp-org:metadata-1-0/upnp/');
	   var item = didl.ele( 'item', { 'id': '0', 'parentID': '-1', 'restricted': 'false'});
	   item.ele( 'upnp:class', {}, 'object.item.audioItem.musicTrack'); 
	   item.ele( 'dc:title', {}, title);
	   item.ele( 'res', { 'protocolInfo': 'http-get:*:audio/mpeg:*' }, url);

	   var xml = xmlBuilder.create('s:Envelope', {version: '1.0', encoding: 'UTF-8'});
	   xml.att( 's:encodingStyle', 'http://schemas.xmlsoap.org/soap/encoding/');
	   xml.att( 'xmlns:s', 	    'http://schemas.xmlsoap.org/soap/envelope/');
	   var transport = xml.ele( 's:Body').ele( 'u:SetAVTransportURI', { 'xmlns:u': 'urn:schemas-upnp-org:service:AVTransport:1' })

		transport.ele( 'InstanceID', {}, 0);
		transport.ele( 'CurrentURI', {}, url);
		transport.ele( 'CurrentURIMetaData', {}, didl.end({ pretty: false}));

	  var body = xml.end({ pretty: true});
	  var dlna_port = 8091;

	  /*
		"<?xml version='1.0' encoding='utf-8'?>\n"+
		'<s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><CurrentURI>'+url+'</CurrentURI><CurrentURIMetaData>&lt;DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:sec="http://www.sec.co.kr/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"&gt;&lt;item id="0" parentID="-1" restricted="false"&gt;&lt;upnp:class&gt;object.item.audioItem.musicTrack&lt;/upnp:class&gt;&lt;dc:title&gt;'+title+'&lt;/dc:title&gt;&lt;res protocolInfo="http-get:*:audio/mpeg:*"&gt;'+url+'&lt;/res&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;</CurrentURIMetaData></u:SetAVTransportURI></s:Body></s:Envelope>'
	*/

      var bose_dlna_url = 'http://' + this.ip + ':' + dlna_port + "/AVTransport/Control";
	  var options = { 
		  'headers' : {
			  'Content-Type': 'text/xml; charset="utf-8"',
			  'SOAPACTION': '"urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI"'
		  },
          'method' : 'POST',
		  'content': body 
	  };

     this.logger.debug( ""+body);

	  urllib.request( bose_dlna_url, options, (err, data, res) => { this._checkUpdateSuccess( err, data, res, handler) } );

	}

	
	/*
        template_file = os.path.join(os.path.dirname(__file__),
                                     'templates/avt_transport_uri.xml')
        with open(template_file, 'r') as template:
            body = template.read().format(url)
            requests.post(
                data=body, headers=headers)

	*/

	/*
	 *
	 */
	sync() {

	  var current = this;

	/*	
	  this._get( 'bassCapabilities', function(err, res, body) {
	    if (err) { return this.logger.info( err); }
	    this.logger.info( ""+body);
	  } );
	  */
	  


	  this._get( 'now_playing', function(err, data, res) {
	    if (err) { return current.logger.warn( err); }

	    xmlParser.parseString( data, function (err, result) {

		if (err) { return current.logger.warn( err); }

		current.parseNowPlaying( result);

	    })

	  });
  	  this.getZone( null);
  	  this.getVolume( null);
	  this.getPresets( null);
	  this.getSources( null);
	  this.networkStatus();

	  return true;
	}

	/*
	 *
	 */
	getInfo( handler) {

	  /*

	   <?xml version="1.0" encoding="UTF-8" ?>
	   <info deviceID="0A1Bxxxxxxx1">
	   <name>Bose-Salon-Rdc</name>
	   <type>SoundTouch Wireless Link Adapter</type>
	   <margeAccountUUID>xxxxxx</margeAccountUUID>
	   <components>
	     <component><componentCategory>SCM</componentCategory><softwareVersion>18.0.11.41145.2696371 epdbuild.rel_18.x.hepdswbld05.2018-02-16T11:31:46</softwareVersion><serialNumber>xxxxxxxxxxxxxxxxxx</serialNumber></component>
	     <component><componentCategory>PackagedProduct</componentCategory><serialNumber>xxxxxxxxxxxxxxxxxxxxxx</serialNumber></component>
	   </components>
	   <margeURL>https://streaming.bose.com</margeURL>
	   <networkInfo type="SCM"><macAddress>xxxxxxxxxxxxxx</macAddress><ipAddress>192.168.2.246</ipAddress></networkInfo>
	   <networkInfo type="SMSC"><macAddress>xxxxxxxxxxxxxx</macAddress><ipAddress>192.168.2.246</ipAddress></networkInfo>
	   <moduleType>sm2</moduleType>
	   <variant>binky</variant>
	   <variantMode>normal</variantMode>
	   <countryCode>GB</countryCode>
	   <regionCode>GB</regionCode>
	   </info>

	   <?xml version="1.0" encoding="UTF-8" ?>
	   <info deviceID="0A1Bxxxxxxx1">
	   <name>Bose-Salon-Haut</name>
	   <type>SoundTouch 10</type>
	   <margeAccountUUID>xxxxxxxxxx</margeAccountUUID>
	   <components>
	     <component><componentCategory>SCM</componentCategory><softwareVersion>18.0.11.41145.2696371 epdbuild.rel_18.x.hepdswbld05.2018-02-16T11:31:46</softwareVersion><serialNumber>xxxxxxxxxxxxxxxxxxxxxx</serialNumber></component>
	     <component><componentCategory>PackagedProduct</componentCategory><softwareVersion>18.0.11.41145.2696371 epdbuild.rel_18.x.hepdswbld05.2018-02-16T11:31:46</softwareVersion><serialNumber>xxxxxxxxxxxxxxxxxE</serialNumber></component>
	   </components>
	   <margeURL>https://streaming.bose.com</margeURL>
	   <networkInfo type="SCM"><macAddress>xxxxxxxxxxxxxxxx</macAddress><ipAddress>192.168.2.232</ipAddress></networkInfo>
	   <networkInfo type="SMSC"><macAddress>xxxxxxxxxxxxxx</macAddress><ipAddress>192.168.2.232</ipAddress></networkInfo>
	   <moduleType>sm2</moduleType>
	   <variant>rhino</variant>
	   <variantMode>normal</variantMode>
	   <countryCode>GB</countryCode>
	   <regionCode>GB</regionCode>
	   </info>
	   */


	  var current = this;
	  this._get( 'info', function(err, data, res) {
	    if (err) { return current.logger.info( err); }
	    xmlParser.parseString( data, function (err, result) {
	      if (err) { return current.logger.info( err); }
	      current.type = result.info.type[0];
	    });
	  });

	}

	/*
	 *
	 */
	notify( key, url, volume, message, handler) {
		var current = this;
		var xml = xmlBuilder.create('play_info', {version: '1.0', encoding: 'UTF-8'})
		xml.ele('app_key', {}, key)
		xml.ele('url',     {}, url)
	        xml.ele('service', {}, message)
	        xml.ele('reason',  {}, message)
	        xml.ele('message', {}, message)
		xml.ele('volume',  {}, volume)

		this.logger.debug( "request notification with "+url)

		this._post( 'speaker', xml, handler);
		// <Error value="409" name="HTTP_STATUS_CONFLICT" severity="Unknown">request not supported in current state</Error>
	}


	/*
	 *
	 */
	selectSpotify( uri, account, handler) {
		var current = this;

		if ( account === null) {
			account = this.accounts.spotify[0].id; //pick first account //FIXME should ensure got at least  account
		}

		this.logger.debug( "request SPOTIFY "+uri+" on account "+account );
		//<ContentItem source="SPOTIFY" type="uri" location="spotify:user:spotify-account:collection" sourceAccount="spotify-account" isPresetable="true">
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
	  this._get( 'presets', function(err, data, res) {
	    if (err) { return current.logger.info( err); }
	    xmlParser.parseString( data, function (err, presets) {
	      if (err) { return current.logger.info( err); }
	      	current.parsePresets( presets)
	    });
	  });
	}


	/*
	 *
	 */
	getSources( handler) {
	  var current = this;
	  this._get( 'sources', function(err, data, res) {
	    if (err) { return current.logger.info( err); }
	    xmlParser.parseString( data, function (err, sources) {
	      if (err) { return current.logger.info( err); }
	      	current.parseSources( sources)
	    });
	  });
	}


	/*
	 *
	 */
	getZone( handler) {
	  var current = this;
	  this._get( 'getZone', function(err, data, res) {
	    if (err) { return current.logger.info( err); }
	    xmlParser.parseString( data, function (err, zone) {
	      if (err) { return current.logger.info( err); }
		    current.parseZone( zone);
	    });
	  });
	}

	/*
	 *
	 */
	getVolume( handler) {
	  var current = this;
	  this._get( 'volume', function(err, data, res) {
	    if (err) { return current.logger.info( err); }
	    xmlParser.parseString( data, function (err, json) {
	      if (err) { return current.logger.info( err); }
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
			this.logger.debug( "adding slaves to existing master")
			this._post('addZoneSlave', this._zone( slaves), handler);
		}
	  }
	  else if( (typeof( this.zone) == 'object') && this.zone.isStandalone) {
	  	//is standalone
		this.logger.debug( "creating new master");
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


	/*
	 * Low level function
	 */
	reboot( handler) {
	  this.logger.debug( "rebooting");
	  this._telnet( 'sys reboot', handler);
	}

	/*
	 *
	 */
	networkStatus( ) {
	  /*
		<Status primaryIsUp="true" primaryIPAddress="192.168.2.231" primaryIsWired="false" accessPointIsUp="false" mode="autoSwitching" elapsedMs="55291332">
		    <interfaceInfo name="lo" type="local" state="up" macAddress="000000000000">
			<ipInfo IPAddress="127.0.0.1" SubnetMask="255.0.0.0" />
		    </interfaceInfo>
		    <interfaceInfo name="wlan0" type="wireless" state="up" macAddress="0CB2XXXXXXXX">
			<ipInfo IPAddress="192.168.2.231" SubnetMask="255.255.255.0" />
		    </interfaceInfo>
		    <interfaceInfo name="usb0" type="wired" state="down" macAddress="6E49XXXXXXXX" />
		    <interfaceInfo name="wlan1" type="wireless" state="down" macAddress="0CB2XXXXXXXX" />
		    <stationStats rssi_dBm="-19" linkSpeed_Mbps="1" noise_dBm="9999" frequency_kHz="2437" width_kHz="20" averageRssi_dBm="-18" txGood_packets="14" txBad_packets="0" rxGood_packets="22" tryAuthenticate="3" tryAssociate="3" connected="3" disconnected="2" handshakeFailed="0" ssidTempDisabled="0" bssid="b0:XX:XX:XX:XX:XX" />
		</Status>
          */

	  var current = this;
	  this._telnet( 'network status', function( err, xml) {

		current.logger.debug( "Fetching network status via telnet");

		if ( err) {
			current.logger.warn( "_telnet error: "+ err);
			return;
		}
		xmlParser.parseString( xml, function( err, data) {
			if (err) {
				current.logger.warn( "_telnet error: "+ err);
				return;
			}
			if( ('Status' in data) && ('stationStats' in data.Status) && (Array.isArray( data.Status.stationStats))) {
				current.stationStats = data.Status.stationStats[0].$; 
			}
			else {
				current.logger.warn( "error while parsing status");
				current.logger.warn( data);
			}
		});
          });
	}

}

module.exports = BoseSoundTouch;


