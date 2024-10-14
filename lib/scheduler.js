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

        var unit="ms"
        var humanTimeout=timeout;
        if (humanTimeout > 1000) {
            humanTimeout = humanTimeout / 1000;
            unit="s";

            if (humanTimeout > 60) {
                humanTimeout = humanTimeout / 60;
                unit="m";

                if (humanTimeout > 60) {
                    humanTimeout = humanTimeout / 60;
                    unit="h";
                }

            }
        }

        this.logger.info(`${name} scheduled in ${humanTimeout}${unit}`);

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
        this.logger.debug(`${name} was not scheduled`);
    }
}

module.exports = Scheduler;

