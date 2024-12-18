'use strict';

const net = require('net');


// ------------------------------------------------------------------------------------------:

class Denon {

	/*
	 *
	 */
	constructor( ip, logger) {
		this.ip = ip;
        this.logger = logger
	}


	/*
	 *
	 */
	call( commands, handler) {

	   var answers = [];
	   var socket = new net.Socket();
	   socket.setTimeout(600);

	   socket.on('error', (err) => {
	     if( typeof( handler) === 'function')
	     {
		handler(err, null);
	     }
	   });

	   socket.on('timeout', () => {

	     if( commands.length )
	     {
		 socket.write( commands.shift()+"\r");
	     }
	     else {
		     //this.logger.debug( "DEBUG "+answers.toString());
		     //denon.write(command+"\r"); // can keep connection
		     socket.end();

		     if( typeof( handler) === 'function')
		     {
		       setTimeout( function() { handler( null, answers); }, 200 );
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
}

module.exports = Denon;

