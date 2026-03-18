function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function estimateMinutes(distKm) { return Math.round((distKm / 25) * 60) + 3; }

function nearestNeighbour(bundles, start) {
  if (!bundles.length) return [];
  const remaining = [...bundles];
  const ordered = [];
  let pos = start;
  while (remaining.length) {
    let bestIdx = 0, bestDist = Infinity;
    remaining.forEach((b, i) => {
      const d = haversine(pos.lat, pos.lng, b.addressLat || pos.lat, b.addressLng || pos.lng);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    });
    const best = remaining.splice(bestIdx, 1)[0];
    ordered.push(best);
    pos = { lat: best.addressLat || pos.lat, lng: best.addressLng || pos.lng };
  }
  return ordered;
}

async function optimiseRoute(bundles, currentPos) {
  if (!bundles.length) return [];
  const urgent  = bundles.filter(b => b.packages?.some(p => p.urgent));
  const regular = bundles.filter(b => !b.packages?.some(p => p.urgent));
  const lastUrgentPos = urgent.length
    ? { lat: urgent[urgent.length-1].addressLat || currentPos.lat, lng: urgent[urgent.length-1].addressLng || currentPos.lng }
    : currentPos;
  const ordered = [...nearestNeighbour(urgent, currentPos), ...nearestNeighbour(regular, lastUrgentPos)];
  let cumMins = 0, pos = currentPos;
  const now = new Date();
  return ordered.map((b, i) => {
    const dist = haversine(pos.lat, pos.lng, b.addressLat || pos.lat, b.addressLng || pos.lng);
    cumMins += estimateMinutes(dist);
    pos = { lat: b.addressLat || pos.lat, lng: b.addressLng || pos.lng };
    return { ...b, stopOrder: i+1, etaMinutes: cumMins, eta: new Date(now.getTime() + cumMins*60000) };
  });
}

function calculateETA(fLat, fLng, tLat, tLng, base=0) {
  const dist = haversine(fLat, fLng, tLat, tLng);
  const mins = estimateMinutes(dist) + base;
  return { eta: new Date(Date.now()+mins*60000), etaMinutes: mins, distanceKm: Math.round(dist*10)/10 };
}

module.exports = { optimiseRoute, calculateETA, haversine, estimateMinutes };
