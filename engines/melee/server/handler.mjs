import http from 'node:http';

// The imported server owns local game data and converters. Only development may
// proxy to it. A public deployment needs a separately authenticated asset service.
export function createMeleeHandler({origin=process.env.MELEE_LOCAL_ORIGIN,production=process.env.NODE_ENV==='production'}={}) {
  let upstream;
  if(origin){
    upstream=new URL(origin);
    if(production || upstream.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(upstream.hostname)
      || upstream.username || upstream.password || upstream.pathname!=='/' || upstream.search || upstream.hash)
      throw Error('MELEE_LOCAL_ORIGIN must be a loopback HTTP origin in development.');
  }
  return function handleMelee(req,res){
    const url=new URL(req.url,'http://localhost');
    if(!/^\/melee\/(api|engine)\//.test(url.pathname))return false;
    if(!upstream){
      const body=JSON.stringify({error:'Melee assets are not configured on this server.'});
      res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(body);return true;
    }
    const headers={...req.headers,host:upstream.host};
    // The browser is talking to this same-origin development server. Never
    // forward website credentials into the local game service.
    delete headers.cookie;delete headers.authorization;delete headers['x-opensmash-token'];
    if(headers.origin){
      if(headers.origin!==`http://${req.headers.host}` && headers.origin!==`https://${req.headers.host}`){res.writeHead(403);res.end();return true;}
      headers.origin=upstream.origin;
    }
    const proxy=http.request(new URL(url.pathname.slice('/melee'.length)+url.search,upstream),{method:req.method,headers}, response=>{
      res.writeHead(response.statusCode,{...response.headers,'Cross-Origin-Resource-Policy':'same-origin'});
      response.pipe(res);
    });
    proxy.setTimeout(120000,()=>proxy.destroy(Error('Melee service timed out')));
    proxy.on('error',()=>{if(!res.headersSent){res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'The local Melee service is unavailable.'}));}else res.destroy();});
    req.on('aborted',()=>proxy.destroy());res.on('close',()=>{if(!res.writableEnded)proxy.destroy();});
    req.pipe(proxy);return true;
  };
}
