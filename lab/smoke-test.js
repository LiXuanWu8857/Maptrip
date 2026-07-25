// smoke-test.js — node lab/smoke-test.js
global.window = global;
global.localStorage = (function(){ var m={}; return {
  getItem:k=>k in m?m[k]:null, setItem:(k,v)=>{m[k]=String(v)},
  removeItem:k=>{delete m[k]} }; })();
// 不提供 indexedDB / navigator → store 退 localStorage、geo 走 mock

require('./geo-gate.js');
require('./geo-clean.js');
require('./trip-store.js');
require('./bg-geo.js');
require('./trip-recorder.js');

(async function(){
  var pass=0, total=0;
  function ck(name, cond){ total++; if(cond)pass++; console.log((cond?'PASS':'FAIL')+'  '+name); }

  // 測 1:品質閘門擋髒點
  var g = window.MaptripGeoGate;
  var p0 = {lat:25.03,lng:121.56,accuracy:10,t:0};
  var pFar = {lat:25.20,lng:121.56,accuracy:10,t:1000};   // 瞬移
  var pBad = {lat:25.031,lng:121.561,accuracy:99,t:2000}; // 精度爛
  ck('gate accept good', g.accept(p0,null).accept === true);
  ck('gate reject teleport', g.accept(pFar,p0).reason === 'teleport');
  ck('gate reject accuracy', g.accept(pBad,p0).reason === 'accuracy');

  // 測 2:store 退 localStorage
  var store = new TripStore(); await store.init();
  ck('store mode = ls', store.mode() === 'ls');

  // 測 3:錄一趟,先落盤,再事後補車資
  var mock = window.MaptripBgGeo._makeMock();
  var rec = new TripRecorder({ store:store, geo:mock,
    now:(function(){var t=0;return function(){return t+=1000;};})() });
  rec.startTrip();
  for (var i=0;i<30;i++) mock._feed({lat:25.03+i*0.0001,lng:121.56,accuracy:5,t:1000+i*1000});
  var trip = rec.endTrip();
  ck('trip saved with fare=0', trip.fare === 0);
  ck('trip has coords', trip.coords.length > 0);
  ck('active cleared', localStorage.getItem('maptrip_lab_active_trip') === null);
  trip.fare = 250; trip.paymentMethod = 'cash'; rec.updateTrip(trip);
  var dk = new Date(trip.startTime).toISOString().slice(0,10);
  ck('fare updated after save',
    store.loadTrips(dk).find(t=>t.id===trip.id).fare === 250);

  // 測 4:被砍自動接回
  var mock2 = window.MaptripBgGeo._makeMock();
  var rec2 = new TripRecorder({ store:store, geo:mock2, now:function(){return 99999;} });
  rec2.startTrip();
  mock2._feed({lat:25.0,lng:121.5,accuracy:5,t:5000});
  var rec3 = new TripRecorder({ store:store, geo:window.MaptripBgGeo._makeMock(),
    now:function(){return 99999;} });
  ck('active trip restored after kill',
    rec3.restoreActiveTrip() === true && rec3.active.coords.length === 1);

  console.log('\n'+pass+'/'+total+' passed');
  process.exit(pass===total?0:1);
})();
