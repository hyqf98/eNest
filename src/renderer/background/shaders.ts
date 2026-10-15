/** Procedural materials approved in the launch preview, without textures or external assets. */
export const BACKGROUND_VERTEX_SHADER = `attribute vec2 position;
void main() { gl_Position = vec4(position, 0., 1.); }`

export const BACKGROUND_FRAGMENT_SHADER = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
 uniform vec2 resolution,pointer;
 uniform float time,opening;
 uniform vec3 baseColor,palette0,palette1,palette2;
 uniform float customPalette,lightTheme;
  mat2 rotate(float a){return mat2(cos(a),-sin(a),sin(a),cos(a));}
 float softBand(float p,float center,float width){return exp(-pow((p-center)/width,2.));}
 vec3 studio(vec3 r,float phase){
  float a=atan(r.x,r.z), y=r.y;
  vec3 c=vec3(.007,.014,.027);
  float large=softBand(a,-.50+phase*.1,.30)*(.42+.58*smoothstep(-.9,.8,y));
  float longLight=softBand(y+sin(a*.8)*.22,.35,.055);
  float strip=softBand(a,1.45,.04)*.65;
  float blue=softBand(a,-1.45,.48)*softBand(y,-.25,.7);
  c+=vec3(.72,.9,1.)*large*1.45;
  c+=vec3(.92,.98,1.)*longLight*.75;
  c+=vec3(.30,.64,1.)*strip;
  c+=vec3(.025,.18,.43)*blue;
  c+=vec3(1.,.48,.20)*softBand(a,2.4,.13)*.28;
  return c;
 }
 vec3 tint(float x){return .65+.35*cos(vec3(.3,1.8,3.1)+x);}
 vec3 foldBackground(vec2 screen){
  vec3 ro=vec3(pointer.x*.12,pointer.y*.09,6.4-opening*.3);
  vec3 rd=normalize(vec3(screen*2.25,-3.35));
  vec3 col=vec3(.007,.012,.023);
  float radial=length(screen-vec2(.04,.01));
  col+=vec3(.015,.044,.072)*exp(-radial*2.7);
  float seam=exp(-abs(screen.x+.025)*190.)*exp(-abs(screen.y)*3.5);
  col+=vec3(.52,.83,1.)*seam*(1.-opening)*.85;
  float haze=exp(-radial*6.5)*(.09+opening*.09);
  col+=vec3(.10,.27,.42)*haze;
  for(int j=0;j<7;j++){
   float i=float(j);
   float spread=smoothstep(0.,1.,clamp(opening*1.30-i*.047,0.,1.));
   float a=i*.8976+.28+sin(time*.32+i*.7)*.055;
   float fold=mix(1.52,.32+sin(i*2.2)*.26,spread)+sin(time*.48+i)*.10*spread;
   vec3 u=normalize(vec3(cos(a)*cos(fold),sin(a)*cos(fold),sin(fold)));
   vec3 v=vec3(-sin(a),cos(a),0.);
   vec3 n=normalize(cross(u,v));
   vec3 origin=vec3(cos(a)*(.09+.08*spread)+sin(i*2.2)*.52*spread,sin(a)*(.09+.08*spread)+cos(i*1.7)*.30*spread,-1.8+i*.24);
   float denom=dot(rd,n);
   if(abs(denom)<.005)continue;
   float t=dot(origin-ro,n)/denom;
   if(t<.05||t>32.)continue;
   vec3 hit=ro+rd*t;
   vec3 local=hit-origin;
   float x=dot(local,u),y=dot(local,v);
   float minX=mix(.15,-.42,step(2.5,i))+.07*sin(i*1.8),maxX=4.4+sin(i)*.5;
   float panelWidth=.11+max(x,0.)*(.26+.06*sin(i*2.4));
   float slant=y-.08*x*sin(i*2.0);
   float inner=x-minX,outer=maxX-x,side=panelWidth-abs(slant);
   float edge=min(min(inner,outer),side);
   if(edge<-.13)continue;
   float facing=abs(dot(n,-rd));
   float fresnel=pow(1.-facing,3.);
   vec3 reflection=reflect(rd,n);
   vec3 reflected=studio(reflection,time*.2+i*.1);
   float swept=softBand(x+slant*.4,1.7+sin(time*.43+i*.2)*1.4,.42);
   vec3 iridescence=tint(facing*6.+x*.22+time*.12);
   vec3 panel=reflected*(.75+fresnel)+vec3(.015,.033,.06);
   panel+=mix(vec3(.26,.59,.85),vec3(.66,.73,.95),iridescence)*swept*.26;
   float cover=smoothstep(-.005,.012,edge);
   float opacity=(.26+.44*fresnel+.20*length(reflected))*cover*spread;
   col=mix(col,panel,clamp(opacity,0.,.90));
   float line=exp(-abs(edge)*210.);
   float glow=exp(-abs(edge)*31.);
   float edgeShift=.5+.5*sin(x*1.5-time*.55+i*1.4);
   vec3 edgeColor=mix(vec3(.22,.55,.80),vec3(.80,.96,1.),edgeShift);
   float depthFade=clamp(1.2-t*.045,.2,1.);
   float glint=pow(.5+.5*sin(x*2.-time*1.2+i),12.);
   col+=edgeColor*(line*(.95+glint*.35)+glow*(.14+glint*.18))*depthFade*spread;
   float innerReflection=exp(-abs(side-.035)*100.)*.10;
   col+=tint(i*.4+time*.07)*innerReflection*cover*spread;
  }
  float sweep=softBand(screen.x+screen.y*.7,mix(-1.2,1.3,smoothstep(.25,.95,opening)),.035);
  col+=vec3(.45,.71,.9)*sweep*sin(opening*3.14159265)*.16;
  float vignette=1.-.34*smoothstep(.2,1.35,length(screen));
  col*=vignette;
  return col;
 }
 // Positions are centered and normalized to canvas height.

// Wide, overlapping silk ribbons: jade body, teal shadow, pale-gold grazing light.
vec3 auroraBackground(vec2 p, float t, float reveal) {
    float entrance = smoothstep(0.0, 1.0, clamp(reveal, 0.0, 1.0));
    float time = t * 0.16;
    vec2 v = p;
    v.x += 0.018 * sin(p.y * 4.0 + time);
    v.y += 0.025 * sin(p.x * 2.3 - time * 0.7);

    vec3 col = vec3(0.011, 0.023, 0.028);
    float halo = exp(-dot((p - vec2(-0.56, 0.15)) * vec2(1.2, 2.3),
                          (p - vec2(-0.56, 0.15)) * vec2(1.2, 2.3)));
    col += vec3(0.012, 0.075, 0.064) * halo * entrance;
    vec3 silk = vec3(0.0);

    for (int i = 0; i < 4; i++) {
        float layer = float(i);
        float phase = time + layer * 1.71;
        float x = v.x + 0.16 * sin(phase * 0.41);
        float frequency = 1.50 + layer * 0.14;
        float curve = 0.25 * sin(x * frequency + phase)
                    + 0.075 * sin(x * 3.8 - phase * 0.73)
                    + (layer - 1.5) * 0.087;
        float slope = 0.25 * frequency * cos(x * frequency + phase)
                    + 0.285 * cos(x * 3.8 - phase * 0.73);
        float dist = (v.y - curve) / sqrt(1.0 + slope * slope);
        float width = 0.063 + 0.026 * (0.5 + 0.5 * sin(x * 1.9 + phase));
        float envelope = exp(-pow(abs(dist) / width, 2.0));
        float fold = 0.30 + 0.70 * pow(0.5 + 0.5 * sin(dist / width * 2.0 + 0.58), 2.0);
        float grazing = exp(-pow((dist - width * 0.42) / (width * 0.18), 2.0));
        float rim = exp(-pow((dist + width * 0.76) / 0.0035, 2.0));
        float fineFold = 0.94 + 0.06 * sin(dist * 370.0 + x * 7.0 + phase);
        float gold = smoothstep(0.22, 0.92, sin(x * 1.1 + phase * 0.68));
        vec3 body = mix(vec3(0.035, 0.48, 0.38), vec3(0.49, 0.48, 0.25), gold);
        vec3 shine = mix(vec3(0.24, 0.91, 0.77), vec3(0.96, 0.89, 0.58), gold);
        float composition = 0.58 + 0.42 * smoothstep(-0.20, 0.90, abs(x));
        float depth = 0.76 + 0.08 * layer;
        silk += composition * depth * (
            body * envelope * fold * fineFold * 0.78
          + shine * grazing * envelope * 0.37
          + shine * rim * 0.17
        );
    }

    // A wide, soft elliptical quiet zone, without a visible cut-out or hard mask.
    vec2 logoZone = p / vec2(0.35, 0.29);
    float centerClear = 1.0 - 0.96 * exp(-dot(logoZone, logoZone) * 1.65);
    silk *= centerClear * entrance;
    col += silk;
    float edge = 1.0 - smoothstep(0.18, 1.50, length(p * vec2(0.65, 1.0)));
    col *= 0.78 + 0.22 * edge;
    return clamp(col / (vec3(1.0) + col * 0.36), 0.0, 1.0);
}

// An inclined accretion disc, with warm matter and a cold-white gravitational rim.
vec3 orbitBackground(vec2 p, float t, float reveal) {
    float entrance = smoothstep(0.0, 1.0, clamp(reveal, 0.0, 1.0));
    float time = t * 0.18;
    float tilt = -0.18 + 0.025 * sin(time * 0.32);
    float ct = cos(tilt);
    float st = sin(tilt);
    vec2 view = vec2(ct * p.x - st * p.y, st * p.x + ct * p.y);
    vec2 disc = view / vec2(1.0, 0.62);
    float radius = length(disc);
    float angle = atan(disc.y, disc.x);
    float twist = angle + 0.10 * sin(angle * 3.0 - time * 0.7);
    float ringRadius = 0.53 + 0.015 * sin(angle * 2.0 + time * 0.35);
    float dist = radius - ringRadius;

    vec3 col = vec3(0.009, 0.015, 0.025);
    float nebula = exp(-dot(p * vec2(0.95, 2.1), p * vec2(0.95, 2.1)) * 1.45);
    col += vec3(0.018, 0.028, 0.046) * nebula;

    // Small static star positions; only their brightness drifts slowly.
    vec2 starGrid = p * 68.0;
    vec2 starCell = floor(starGrid);
    float seed = fract(sin(dot(starCell, vec2(127.1, 311.7))) * 43758.5453);
    vec2 starLocal = fract(starGrid) - vec2(
        fract(seed * 91.73), fract(seed * 43.19));
    float stars = step(0.994, seed) * exp(-dot(starLocal, starLocal) * 140.0);
    stars *= 0.30 + 0.20 * sin(t * 0.45 + seed * 80.0);
    col += stars * vec3(0.63, 0.76, 0.91) * entrance;

    // The disc has a broad shaded body, filament texture and one luminous inner lip.
    float body = exp(-pow(dist / 0.047, 2.0));
    float filaments = 0.70 + 0.18 * sin(dist * 530.0 - twist * 8.0 + time * 1.7)
                            + 0.12 * sin(dist * 920.0 + twist * 5.0 - time);
    float matter = 0.68 + 0.32 * sin(twist * 4.0 - time * 1.5 + dist * 68.0);
    float hotRim = exp(-pow((dist + 0.019) / 0.0045, 2.0));
    float rimHalo = exp(-abs(dist + 0.019) * 47.0);
    float front = smoothstep(-0.22, 0.18, -view.y);
    float lighting = 0.52 + 0.68 * front;
    vec3 warm = mix(vec3(0.78, 0.25, 0.046), vec3(0.99, 0.60, 0.22), matter);
    vec3 discColor = warm * body * filaments * lighting * 0.78;
    discColor += vec3(0.74, 0.85, 1.0) * hotRim * lighting * 0.78;
    discColor += vec3(0.44, 0.32, 0.20) * rimHalo * 0.31;

    // Broken outer orbital arcs; different orientations prevent a target-board look.
    for (int i = 0; i < 3; i++) {
        float layer = float(i);
        float arcAngle = twist + layer * 2.1 - time * (0.24 + layer * 0.12);
        float arcRadius = ringRadius + 0.095 + layer * 0.068
                        + 0.016 * sin(angle * 2.0 + layer);
        float arcDistance = radius - arcRadius;
        float segment = pow(max(0.0, 0.5 + 0.5 * sin(arcAngle)), 5.0);
        float arc = exp(-abs(arcDistance) * 610.0) * segment;
        float arcGlow = exp(-abs(arcDistance) * 85.0) * segment;
        vec3 arcColor = mix(vec3(0.31, 0.53, 0.72), vec3(0.79, 0.56, 0.26), layer * 0.35);
        discColor += arcColor * (arc * 0.46 + arcGlow * 0.045);
    }

    // A small moving concentration of matter produces a restrained lens-like flare.
    float beadAngle = time * 0.60 + 0.80;
    vec2 bead = vec2(cos(beadAngle), sin(beadAngle)) * 0.53;
    vec2 beadDist = disc - bead;
    float beadGlow = exp(-dot(beadDist, beadDist) * 185.0);
    float beadCore = exp(-dot(beadDist, beadDist) * 3100.0);
    discColor += vec3(0.80, 0.85, 1.0) * beadGlow * 0.26
               + vec3(1.0, 0.87, 0.63) * beadCore * 0.75;

    // Preserve a dark center for the existing logo, eNest wordmark and subtitle.
    vec2 logoZone = p / vec2(0.32, 0.28);
    float centerClear = 1.0 - 0.96 * exp(-dot(logoZone, logoZone) * 1.8);
    col += discColor * centerClear * entrance;
    float vignette = 1.0 - 0.24 * smoothstep(0.38, 1.1, length(p));
    col *= vignette;
    return clamp(col / (vec3(1.0) + col * 0.29), 0.0, 1.0);
}

 float waterHeight(vec2 p,float t){
  float r=length(p+vec2(.3,-.1));
  return sin(p.x*4.2+p.y*1.6+t*.48)*.17+sin(p.y*6.4-p.x*1.3-t*.39)*.11+sin(r*9.-t*.7)*.065+sin(p.x*10.+p.y*8.+t*.28)*.025;
 }
 vec3 waterBackground(vec2 p,float t,float reveal){
  vec2 q=p*2.8;
  float h=waterHeight(q,t),e=.015;
  vec3 n=normalize(vec3((h-waterHeight(q+vec2(e,0.),t))/e,(h-waterHeight(q+vec2(0.,e),t))/e,1.25));
  vec3 rd=normalize(vec3(p*.35,-1.));
  vec3 reflected=studio(reflect(rd,n),0.);
  float sheen=pow(max(dot(n,normalize(vec3(-.6,.65,.8))),0.),18.);
  vec3 col=vec3(.008,.019,.038)+reflected*vec3(.34,.55,.75)*.68+vec3(.61,.79,.94)*sheen*.65;
  float d=abs(length(p)-reveal*1.5);
  col+=vec3(.13,.46,.65)*exp(-d*42.)*sin(reveal*3.14159)*.3;
  col*=mix(.04,1.,smoothstep(0.,.85,reveal));
  col*=.65+.35*smoothstep(.1,.55,length(p));
  return col;
 }
 vec3 tunnelBackground(vec2 p,float t,float reveal){
  vec3 c=vec3(.004,.011,.022);float r=length(p);
  float twist=.10*sin(t*.23);
  for(int j=0;j<21;j++){
   float i=float(j),size=.155*pow(1.14,i)*(.12+.88*reveal);
   vec2 q=rotate(i*.027+twist+i*.002*sin(t*.3))*p;
   float a=atan(q.y,q.x)+3.14159265;
   float hex=length(q)*cos(mod(a,1.04719755)-.52359877);
   float d=abs(hex-size);
   float edge=exp(-d*350./(1.+size*.7));
   float bloom=exp(-d*65.);
   float highlight=pow(.5+.5*sin(a*2.-t*.7+i*.43),6.);
   vec3 hue=mix(vec3(.025,.24,.47),vec3(.45,.89,1.),highlight);
   float alpha=(.32+i*.028)*smoothstep(i*.027,i*.027+.3,reveal);
   c+=hue*(edge*.78+bloom*.10)*alpha;
  }
  c+=vec3(.005,.04,.07)*exp(-r*2.);
  return c*(1.-.25*smoothstep(.4,1.5,r));
 }
 void main(){
  vec2 p=(gl_FragCoord.xy/resolution-.5)*vec2(resolution.x/resolution.y,1.);
  p-=pointer*.012;
  vec3 c;
  if(mode<.5)c=foldBackground(p);
  else if(mode<1.5)c=auroraBackground(p,time,opening);
  else if(mode<2.5)c=orbitBackground(p,time,opening);
  else if(mode<3.5)c=waterBackground(p,time,opening);
  else c=tunnelBackground(p,time,opening);
  c=max(c,0.);c=c/(1.+c*.42);c=pow(c,vec3(.88));
  float energy=max(max(c.r,c.g),c.b);
  vec3 custom=mix(palette0,palette1,smoothstep(.03,.42,energy));
  custom=mix(custom,palette2,smoothstep(.38,.93,energy));
  c=mix(c,custom*energy,customPalette);
  vec3 lightField=max(vec3(0.),c-vec3(.009,.014,.023));
  vec3 darkResult=baseColor+(vec3(1.)-baseColor)*lightField;
  vec3 ink=.10+normalize(max(c,vec3(.001)))*.46;
  vec3 lightResult=mix(baseColor,ink,clamp(energy*.84,0.,.76));
  gl_FragColor=vec4(clamp(mix(darkResult,lightResult,lightTheme),0.,1.),1.);
 }`
