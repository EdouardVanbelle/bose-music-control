/* Sample
{
  '_events': {},
  '_eventsCount': 1,
  'name': 'Bose-Salon-Rdc',
  'ip': '192.168......',
  'mac': '04A31....',
  'model': 'SoundTouch',
  'port': 8090,
  'info': null,
  'powerOn': true,
  'playStatus': null,
  'source': 'INTERNET_RADIO',
  'playing': {
    'track': '',
    'artist': '',
    'album': '',
    'stationName': 'VRT Studio Brussel',
    'art': 'http://item.radio456.com/007452/logo/logo-4712.jpg',
    'playStatus': 'PLAY_STATE',
    'description': 'MP3  128 kbps  Brussels Belgium,  Studio BruBel geeft je overdag de beste pop-, rock- en dansmuziek en \'s avonds een eigenzinnige selectie van genres en stijlen. Life is Music',
    'stationLocation': 'Brussels Belgium'
  },
  'soundTouchVersion': '4',
  'type': 'SoundTouch Wireless Link Adapter',
  'zone': {
    'isSlave': false,
    'isMaster': true,
    'isStandalone': false,
    'slaves': [
      'A0F6FD3....'
    ],
    'master': '04A31.....'
  },
  'volume': {
    'current': '20',
    'mute': false
  }
}
*/



( function($) {

   $(document).ready( () => {

   	//$("#actionFrm").on( "load", () => {
	//   alert( "loaded: "+$("#actionFrm").attr('src'));
   	//});

	$('.volume').each( (index, value ) => {

		$( value ).on('input', (e) => {
			var input = $(e.target);
			input.next().text( input.val());
		});
		$( value ).on('change', (e) => {
			var input = $(e.target);
			$.ajax( {
				url: "/api/bose/"+input.data('mac')+"/volume/" + input.val(),
				success: () => {
					console.log("volume updated");
				}
			} );
		});
		$(value).trigger('input'); //force display of volume value
	});

	$('.custom-notification').submit( (event) => {

		var lang    = $(event.target).find("input[name=lang]").first();
		var message = $(event.target).find("input[name=message]").first();

		var url = window.location.origin+'/api/bose/ALL/custom-notify/'+lang.val()+'/'+encodeURIComponent( message.val());

		$("#actionFrm").attr('src', url);

		//clean
		message.val("");

		event.preventDefault();
	});

    });
} ) (jQuery);

