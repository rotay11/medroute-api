const https = require('https');

// Geocode an address string to {lat, lng} using Google Geocoding API
// Returns null if geocoding fails (caller should handle gracefully)
async function geocodeAddress(address) {
  const apiKey = process.env.GOOGLE_GEOCODING_API_KEY;
  console.log('[GEOCODE] called with address:', address, '| apiKey present:', !!apiKey, '| apiKey length:', apiKey ? apiKey.length : 0);
  if (!apiKey || !address) {
    console.log('[GEOCODE] returning null - missing apiKey or address');
    return null;
  }

  const encodedAddress = encodeURIComponent(address);
  const url = 'https://maps.googleapis.com/maps/api/geocode/json?address=' + encodedAddress + '&key=' + apiKey;

  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.status === 'OK' && parsed.results && parsed.results[0]) {
            const loc = parsed.results[0].geometry.location;
            console.log('[GEOCODE] SUCCESS:', address, '->', loc.lat, loc.lng);
            resolve({ lat: loc.lat, lng: loc.lng });
          } else {
            console.log('Geocode failed for address:', address, 'status:', parsed.status);
            resolve(null);
          }
        } catch (err) {
          console.log('Geocode parse error:', err.message);
          resolve(null);
        }
      });
    }).on('error', (err) => {
      console.log('Geocode request error:', err.message);
      resolve(null);
    });
  });
}

module.exports = { geocodeAddress };
