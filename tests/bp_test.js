// Same body-parser setup as connectbox-manage index.js, echo what was parsed
const express = require(process.argv[2] + '/node_modules/express'), bodyParser = require(process.argv[2] + '/node_modules/body-parser');
const app = express();
app.use(bodyParser.json({ type: 'application/json', limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(bodyParser.text({ type: 'text/html' , limit: '50mb'}));
app.all('/echo', (req, res) => res.json({ body: req.body }));
const srv = app.listen(0, async () => {
  const port = srv.address().port, http = require('http');
  const send = (ctype, data) => new Promise(ok => {
    const r = http.request({ port, path: '/echo', method: 'PUT', headers: { 'Content-Type': ctype } }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => ok(res.statusCode + ' ' + b)); });
    r.end(data);
  });
  let pass = 0, fail = 0;
  const check = (name, got, want) => { const ok = got.startsWith(want); ok ? pass++ : fail++;
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' got ' + got.slice(0, 120) + ' want ' + want)); };
  check('json', await send('application/json', JSON.stringify({ password: 'x y', value: 'abc' })), '200 {"body":{"password":"x y","value":"abc"}}');
  check('form', await send('application/x-www-form-urlencoded', 'value=a%20b&arr[0]=1'), '200 {"body":{"value":"a b","arr":["1"]}}');
  check('text', await send('text/html', 'Hello <b>box</b>'), '200 {"body":"Hello <b>box</b>"}');
  check('bad json gives 400', await send('application/json', '{bad'), '400 ');
  console.log(pass + ' passed, ' + fail + ' failed');
  srv.close();
});
