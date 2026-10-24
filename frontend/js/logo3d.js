/* Logo 3D Compoint: red de nodos girando en el espacio. Sin librerías. */
(function(){
function Logo3D(canvas, opt){
  opt = opt || {};
  var ctx = canvas.getContext('2d');
  var W=0,H=0,dpr=1;
  function size(){ dpr=Math.min(window.devicePixelRatio||1,2); W=canvas.clientWidth; H=canvas.clientHeight; canvas.width=W*dpr; canvas.height=H*dpr; ctx.setTransform(dpr,0,0,dpr,0,0); }
  size();
  // nodos: 12 puntos en esfera (espiral de Fibonacci) + centro verde
  var N=12, P=[], i;
  for(i=0;i<N;i++){ var y=1-2*(i+.5)/N, r=Math.sqrt(1-y*y), a=i*2.399963; P.push([Math.cos(a)*r,y,Math.sin(a)*r]); }
  var E=[]; // aristas: cada nodo con sus 3 vecinos más cercanos
  function d2(a,b){return (a[0]-b[0])*(a[0]-b[0])+(a[1]-b[1])*(a[1]-b[1])+(a[2]-b[2])*(a[2]-b[2]);}
  var seen={};
  for(i=0;i<N;i++){
    var ds=[]; for(var j=0;j<N;j++) if(j!==i) ds.push([d2(P[i],P[j]),j]);
    ds.sort(function(x,y){return x[0]-y[0]});
    for(var k=0;k<3;k++){ var jj=ds[k][1], key=Math.min(i,jj)+'-'+Math.max(i,jj); if(!seen[key]){seen[key]=1;E.push([i,jj]);} }
  }
  // polvo de fondo
  var D=[]; var s=7; function rnd(){ s=(s*16807)%2147483647; return (s-1)/2147483646; }
  for(i=0;i<70;i++){ var u=rnd()*2-1, t=rnd()*6.283, rr=1.3+rnd()*1.1, q=Math.sqrt(1-u*u); D.push([Math.cos(t)*q*rr,u*rr,Math.sin(t)*q*rr,.4+rnd()*1.2]); }
  // pulsos de luz
  var PU=[]; for(i=0;i<14;i++) PU.push({e:(i*5)%E.length, off:rnd(), v:.18+rnd()*.14, c:(i%3===0)});
  var G=[95,174,70], GL=[139,224,109];
  function rot(p,ay,ax){ var x=p[0]*Math.cos(ay)+p[2]*Math.sin(ay), z=-p[0]*Math.sin(ay)+p[2]*Math.cos(ay), y=p[1];
    var y2=y*Math.cos(ax)-z*Math.sin(ax), z2=y*Math.sin(ax)+z*Math.cos(ax); return [x,y2,z2]; }
  function proj(p,cx,cy,R){ var f=3.2, k=f/(f+p[2]); return [cx+p[0]*R*k, cy+p[1]*R*k, k]; }
  function glow(x,y,r,c,a){ var g=ctx.createRadialGradient(x,y,0,x,y,r); g.addColorStop(0,'rgba('+c[0]+','+c[1]+','+c[2]+','+a+')'); g.addColorStop(1,'rgba('+c[0]+','+c[1]+','+c[2]+',0)'); ctx.fillStyle=g; ctx.beginPath(); ctx.arc(x,y,r,0,6.283); ctx.fill(); }
  var mx=0,my=0; if(opt.parallax!==false){ window.addEventListener('mousemove',function(e){ mx=(e.clientX/innerWidth-.5); my=(e.clientY/innerHeight-.5); }); }
  var cmx=0,cmy=0;
  function draw(t){
    ctx.clearRect(0,0,W,H);
    cmx+=(mx-cmx)*.05; cmy+=(my-cmy)*.05;
    var cx=W/2, cy=H/2, R=Math.min(W,H)*.34;
    var ay=t*.45+cmx*1.2, ax=.38+Math.sin(t*.3)*.12+cmy*.6;
    var scale=1+Math.min(t,1.6)*0; // sin zoom
    var appear=Math.min(1,t/1.4); appear=1-Math.pow(1-appear,3);
    ctx.globalCompositeOperation='lighter';
    // halo central
    glow(cx,cy,R*1.25,G,.20*appear); 
    // anillos orbitales (elipses 3D)
    for(var ring=0;ring<2;ring++){
      ctx.beginPath();
      for(var a=0;a<=64;a++){ var th=a/64*6.283, p=[Math.cos(th)*1.45,0,Math.sin(th)*1.45];
        var tilt=ring?1.15:-.5; var py=p[1]*Math.cos(tilt)-p[2]*Math.sin(tilt), pz=p[1]*Math.sin(tilt)+p[2]*Math.cos(tilt); p=[p[0],py,pz];
        var q=proj(rot(p,ay*.6+ring,ax),cx,cy,R); if(a===0) ctx.moveTo(q[0],q[1]); else ctx.lineTo(q[0],q[1]); }
      ctx.strokeStyle='rgba(139,224,109,'+(.16*appear)+')'; ctx.lineWidth=1; ctx.stroke();
    }
    // polvo
    for(i=0;i<D.length;i++){ var p=rot(D[i],ay*.5+t*.05,ax), q=proj(p,cx,cy,R*.9), al=(.18+.35*(q[2]-.7))*appear*(.6+.4*Math.sin(t*1.5+i));
      ctx.fillStyle='rgba(190,245,170,'+Math.max(0,al)+')'; ctx.beginPath(); ctx.arc(q[0],q[1],D[i][3]*q[2]*1.1,0,6.283); ctx.fill(); }
    // puntos 3D
    var Q=[]; for(i=0;i<N;i++){ var pp=rot([P[i][0]*appear,P[i][1]*appear,P[i][2]*appear],ay,ax); Q.push({p:pp,q:proj(pp,cx,cy,R)}); }
    var C={p:[0,0,0],q:[cx,cy,1]};
    // líneas al centro y entre vecinos
    function line(A,B,rgb,alpha,w){ var dz=(A.p[2]+B.p[2])/2; var depth=.35+.65*((1-dz)/2+.25); ctx.strokeStyle='rgba('+rgb+','+(alpha*Math.max(.15,Math.min(1,depth))*appear)+')'; ctx.lineWidth=w; ctx.beginPath(); ctx.moveTo(A.q[0],A.q[1]); ctx.lineTo(B.q[0],B.q[1]); ctx.stroke(); }
    for(i=0;i<N;i++) line(Q[i],C,'139,224,109',.38,1.1);
    for(i=0;i<E.length;i++) line(Q[E[i][0]],Q[E[i][1]],'235,255,230',.55,1.3);
    // pulsos viajando
    for(i=0;i<PU.length;i++){ var pu=PU[i], f=(t*pu.v+pu.off)%1, A,B;
      if(pu.c){ A=Q[E[pu.e][0]]; B=C; } else { A=Q[E[pu.e][0]]; B=Q[E[pu.e][1]]; }
      var x=A.q[0]+(B.q[0]-A.q[0])*f, y=A.q[1]+(B.q[1]-A.q[1])*f; var al=Math.sin(f*3.1416)*appear;
      glow(x,y,13,GL,.75*al); ctx.fillStyle='rgba(235,255,225,'+al+')'; ctx.beginPath(); ctx.arc(x,y,2.3,0,6.283); ctx.fill(); }
    // nodos (ordenados por profundidad: los lejanos primero)
    var ord=Q.slice().sort(function(a,b){return b.p[2]-a.p[2]});
    for(i=0;i<ord.length;i++){ var n=ord[i], dep=(1-n.p[2])/2, k=n.q[2], rad=(4.6+3*dep)*k;
      glow(n.q[0],n.q[1],rad*3.2,[200,255,190],.28*dep*appear+.05); ctx.fillStyle='rgba(255,255,255,'+(.55+.45*dep)*appear+')'; ctx.beginPath(); ctx.arc(n.q[0],n.q[1],rad,0,6.283); ctx.fill(); }
    // centro verde con ondas
    var beat=1+.14*Math.sin(t*3); glow(cx,cy,R*.34*beat,G,.85*appear);
    ctx.globalCompositeOperation='source-over';
    var rg=ctx.createRadialGradient(cx-4,cy-4,1,cx,cy,R*.1*beat); rg.addColorStop(0,'#c9f7b4'); rg.addColorStop(.45,'#5FAE46'); rg.addColorStop(1,'#3d8a2c');
    ctx.fillStyle=rg; ctx.beginPath(); ctx.arc(cx,cy,R*.1*beat*appear,0,6.283); ctx.fill();
    ctx.globalCompositeOperation='lighter';
    for(var w=0;w<2;w++){ var ph=((t*.55+w*.5)%1); ctx.strokeStyle='rgba(139,224,109,'+(1-ph)*.55*appear+')'; ctx.lineWidth=2; ctx.beginPath(); ctx.arc(cx,cy,R*.1+ph*R*.7,0,6.283); ctx.stroke(); }
    ctx.globalCompositeOperation='source-over';
  }
  var raf, t0=performance.now();
  function loop(){ draw((performance.now()-t0)/1000); raf=requestAnimationFrame(loop); }
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(opt.fixed!=null) draw(opt.fixed); else if(reduce) draw(3); else loop();
  window.addEventListener('resize',function(){size(); if(opt.fixed!=null) draw(opt.fixed);});
  return {draw:draw, stop:function(){cancelAnimationFrame(raf)}};
}
window.Logo3D=Logo3D;
})();
