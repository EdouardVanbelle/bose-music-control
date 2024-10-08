'use strict';


// ------------------------------------------------------------------------------------------:

class Scheduler {

	/*
	 *
	 */
	constructor( logger) {
        this.logger    = logger.child( { context: 'scheduler'} );
        this.schedules = {};
	}

    schedule( name, handler, timeout, override=false) {

        var self = this;
        
        if( name in this.schedules) {
            if (!override) {
                this.logger.info(`${name} already scheduled`);
                return;
            }
            clearTimeout( this.schedules[name]);
        }

        this.logger.info(`${name} scheduled in ${timeout}ms`);

        //XXX should simply refresh()
        this.schedules[name] = setTimeout( 
            function() {
                self.logger.info(`${name} time to fire !`);
                handler();
                delete self.schedules[name];
            }, 
            timeout
        );
    }

    cancel( name) {
        if( name in this.schedules) {
            clearTimeout( this.schedules[name]);
            delete this.schedules[name];
            this.logger.info(`${name} canceled`);
            return;
        }
        this.logger.info(`${name} was not scheduled`);
    }
}

module.exports = Scheduler;

