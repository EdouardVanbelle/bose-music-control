'use strict';

const EventEmitter = require('events');
const GCastClient                = require('castv2-client').Client;
const GCastDefaultMediaReceiver  = require('castv2-client').DefaultMediaReceiver;


const servicesByName  = {};
const servicesById   = {};

const nestModels = [ "Google Home Mini", "Google Nest Mini", "Nest Audio" ];

class Chromecast extends EventEmitter {

	/*
	 *
	 */
	constructor( name, ip, id, model, logger) {

		super(); 

		this.discoverTime = new Date();

		this.name   = name;
		this.ip     = ip;
		this.model  = model;
        this.id     = id;
        this.logger = logger.child({ context: `cast: ${this.name}`});

        this.client = null;
        this.player = null;

	}

	toString() {
		return String( this.name);
	}

	/*
	 *
	 */
	register() {

  		this.logger.info( `registering new chromecast device ${this.name} (${this.id}) model: ${this.model}`);
		servicesById[  this.id ] = this;
		servicesByName[ this.name ] = this;
	}

	/*
	 *
	 */
	unregister() {
  		this.logger.info( "unregistering device");

		// this.end(); // close all connections if necessary

		delete servicesById[  this.id ];
		delete servicesByName[ this.name ];
	}

	static lookup( key) {
		if (key in servicesById)
			return servicesById[key];

		if (key in servicesByName)
			return servicesByName[key];

		return null; // not found
	}

	static registered() {
		return Object.values( servicesById);
	}

    isNest() {
        return nestModels.indexOf( this.model) != -1;
    }

    isGroup() {
        return this.model === "Google Cast Group";
    }

    connect() {

        var self = this;

        var client = new GCastClient();
        client.connect( this.ip, function() {


            self.client = client;
            self.player = null;
            self.sessionId = null;

            client.on('status', function( status) {
                //self.logger.info(`status updated: ${JSON.stringify(status, null, 2)}`);
                if (!("applications" in status)) {
                    return;
                }

                if (status.applications.length == 0) {
                    self.logger.debug(`no more application`);
                    return;
                }

                for( var application of status.applications) {

                    var supportMedia = false;

                    if(!( "namespaces" in application)) {
                        self.logger.info(`no session for application ${application.displayName}`);
                        continue;
                    }

                    for (var namespace of application.namespaces) {
                        if( namespace.name === "urn:x-cast:com.google.cast.media") {
                            supportMedia = true;
                            break;
                        }
                    }

                    if (self.sessionId === application.sessionId) {
                        self.logger.debug(`already connected to session ${self.sessionId}`);
                        continue;
                    }

                    self.logger.info(`new running app ${application.displayName} supporting media ${supportMedia} with session ${application.sessionId} text:${application.statusText}`);

                    if (supportMedia) {
                        //FIXME: not working
                        //if ( self.player) {
                        //    self.player.close();
                        //}

                        client.join( application, GCastDefaultMediaReceiver, function(err, player) {
                            if (err !== null) {
                                self.logger.warn( err);
                                return
                            }
                            self.logger.info(`generic player joined with session ${application.sessionId}`);
                            self.player = player;
                            self.sessionId = application.sessionId;

                            //important to synchronize
                            player.getStatus( function(err, status) {
                                //self.logger.info(`player status ${JSON.stringify(status, null, 2)}`);
                            });

                            player.on('status', function(status) {
                                self.logger.info(`new player status ${status.playerState}`);
                            });
                            //player.on('status', function(status) {
                            //    self.logger.info(`status broadcast playerState=${status.playerState} volume=${status.volume.level}`);
                            //});
                        });
                    }
                }
            });

            /*
            client.getStatus( function( err, status) {
                self.logger.info( `status ${JSON.stringify( status, null, 2)}`);
            });
            */
            
            client.getSessions( function( err, sessions) {

                if (sessions.length == 0) {
                    self.logger.info("connected, device is in standby");
                    return;
                }

                for( var session of sessions) {

                    //self.logger.info( JSON.stringify( session, null, 2));

                    if(!( "namespaces" in session)) {
                        self.logger.info(`no session for application ${session.displayName}`);
                        continue;
                    }

                    for (var namespace of session.namespaces) {

                        if( namespace.name === "urn:x-cast:com.google.cast.media") {

                            self.logger.info(`got a session for app ${session.displayName} with session ${session.sessionId} supporting the generic media player, connecting a receiver`);

                            client.join( session, GCastDefaultMediaReceiver, function(err, player) {
                                if (err !== null) {
                                    self.logger.warn( err);
                                    return
                                }
                                self.player = player;
                                self.sessionId = player.session.sessionId;
                                //self.sessionId = session.sessionId;
                                self.logger.info(`joined session ${session.sessionId}`);

                                //important to synchronize
                                player.getStatus( function(err, status) {
                                    //self.logger.info(`player status ${JSON.stringify(status, null, 2)}`);
                                })

                                player.on('status', function(status) {
                                    self.logger.info(`new player status ${status.playerState}`);
                                });

                            });

                            // exit loops
                            break;
                        }
                    }

                    if (!self.player) {
                        self.logger.info(`unsupported application ${session.displayName} is running`);
                    }
                }

            });

        });
 
        client.on('error', function(err) {
            self.logger.warn(`Error: ${err.message}`);
            client.close();
            self.client = null;
            self.player = null;
            self.sessionId = null;
        });
    }


    pause() {
    }

    play() {
    }

    notify(url, handler) {

        var self = this;
        var media = {
            contentId: url,
            contentType: 'audio/mp3',
            streamType: 'BUFFERED', // or LIVE
        };

        if (!this.client) {
            self.logger("not connected, ignore this device");
            return
            // warning connection is done in background, race condition may occurs
            //this.connect();
        }
       
        if (this.player && this.player.session && this.player.session.appId === "CC1AD845") {
            // use the active player 
            this.player.load( media, { autoplay: true}, handler);
            return;
        }

        //register a new player
        this.client.launch(GCastDefaultMediaReceiver, function(err, player) {

            if (err !== null) {
                handler( err, null);
                return
            }

            self.player = player;
            self.sessionId = player.session.sessionId;

            player.on('status', function(status) {
                self.logger.info(`new player status ${status.playerState}`);
            });

            self.logger.info(`application ${player.session.displayName} launched, loading media ${media.contentId} ...`);

            player.load(media, { autoplay: true }, handler);

        });

    }

}


module.exports = Chromecast;

