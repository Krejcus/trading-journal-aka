/**
 * Kouř za kurzorem (Vzhled → Reakce na myš → Kouř): malá simulace tekutiny
 * ve WebGL. Barva se vpouští po dráze myši, proudění ji stáčí do vírů a
 * pomalu se rozplyne. Čistě ozdobná vrstva pod obsahem aplikace — nic
 * nečte ani nezapisuje a kliknutí ani klávesy nezachytává.
 */

export interface SmokeFluid {
  /** Jeden krok: `pointer` v 0–1 (y odspodu), `color` 0–1 RGB, `strength` ≈ 1 = běžná síla. */
  step(dt: number, pointer: [number, number] | null, color: [number, number, number], strength: number): void;
  /** Obláček na místě kliknutí. */
  puff(x: number, y: number): void;
  /** Zapomene poslední polohu myši (po pauze by jinak vznikl dlouhý pruh). */
  resetPointer(): void;
  clear(): void;
  dispose(): void;
}

const VERTEX = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
const HEAD = 'precision highp float;uniform vec2 px;\n';
const NEIGHBOURS = 'vec2 uv=gl_FragCoord.xy*px;vec2 l=uv-vec2(px.x,0.),rr=uv+vec2(px.x,0.),tt=uv+vec2(0.,px.y),bb=uv-vec2(0.,px.y);';
const SHADERS = {
  advect: 'uniform sampler2D V,S;uniform vec2 tx;uniform float dt,ds;void main(){vec2 uv=gl_FragCoord.xy*px;vec2 c=uv-dt*texture2D(V,uv).xy*tx;gl_FragColor=vec4(texture2D(S,c).xyz/(1.+ds*dt),1.);}',
  splat: 'uniform sampler2D T;uniform vec3 col;uniform vec2 pt;uniform float rad,asp;void main(){vec2 uv=gl_FragCoord.xy*px;vec2 d=uv-pt;d.x*=asp;gl_FragColor=vec4(texture2D(T,uv).xyz+exp(-dot(d,d)/rad)*col,1.);}',
  curl: `uniform sampler2D V;void main(){${NEIGHBOURS}float L=texture2D(V,l).y,R=texture2D(V,rr).y,T=texture2D(V,tt).x,B=texture2D(V,bb).x;gl_FragColor=vec4(.5*(R-L-T+B),0.,0.,1.);}`,
  vorticity: `uniform sampler2D V,C;uniform float dt,k;void main(){${NEIGHBOURS}float L=texture2D(C,l).x,R=texture2D(C,rr).x,T=texture2D(C,tt).x,B=texture2D(C,bb).x,c=texture2D(C,uv).x;vec2 f=.5*vec2(abs(T)-abs(B),abs(R)-abs(L));f/=length(f)+.0001;f*=k*c;f.y*=-1.;gl_FragColor=vec4(clamp(texture2D(V,uv).xy+f*dt,-1000.,1000.),0.,1.);}`,
  divergence: `uniform sampler2D V;void main(){${NEIGHBOURS}float L=texture2D(V,l).x,R=texture2D(V,rr).x,T=texture2D(V,tt).y,B=texture2D(V,bb).y;gl_FragColor=vec4(.5*(R-L+T-B),0.,0.,1.);}`,
  pressure: `uniform sampler2D Pr,Dv;void main(){${NEIGHBOURS}float L=texture2D(Pr,l).x,R=texture2D(Pr,rr).x,T=texture2D(Pr,tt).x,B=texture2D(Pr,bb).x;gl_FragColor=vec4((L+R+B+T-texture2D(Dv,uv).x)*.25,0.,0.,1.);}`,
  gradient: `uniform sampler2D Pr,V;void main(){${NEIGHBOURS}float L=texture2D(Pr,l).x,R=texture2D(Pr,rr).x,T=texture2D(Pr,tt).x,B=texture2D(Pr,bb).x;gl_FragColor=vec4(texture2D(V,uv).xy-vec2(R-L,T-B),0.,1.);}`,
  fade: 'uniform sampler2D T;uniform float k;void main(){gl_FragColor=k*texture2D(T,gl_FragCoord.xy*px);}',
  // Výstup s průhledností (předem vynásobená alfa): kouř leží nad pozadím, nic nezakrývá naplno.
  display: 'uniform sampler2D D;uniform float k;void main(){vec3 dy=texture2D(D,gl_FragCoord.xy*px).rgb;float di=max(dy.r,max(dy.g,dy.b));float a=clamp(di*k,0.,1.)*.6;gl_FragColor=vec4(dy/max(di,.0001)*a,a);}',
};

const SIM_W = 192, SIM_H = 108, DYE_W = 768, DYE_H = 432;

interface Target { texture: WebGLTexture; framebuffer: WebGLFramebuffer; width: number; height: number }
type Program = WebGLProgram & { uniform(name: string): WebGLUniformLocation | null };

/** Vrátí null, když prohlížeč neumí WebGL s poloviční přesností — kouř se pak prostě nekreslí. */
export function createSmokeFluid(canvas: HTMLCanvasElement): SmokeFluid | null {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
  if (!gl) return null;
  const halfFloat = gl.getExtension('OES_texture_half_float');
  if (!halfFloat || !gl.getExtension('OES_texture_half_float_linear')) return null;
  gl.getExtension('EXT_color_buffer_half_float');

  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, VERTEX);
  const program = (fragment: string): Program => {
    const linked = gl.createProgram()!;
    gl.attachShader(linked, vertex);
    gl.attachShader(linked, compile(gl.FRAGMENT_SHADER, HEAD + fragment));
    gl.bindAttribLocation(linked, 0, 'p');
    gl.linkProgram(linked);
    const cache: Record<string, WebGLUniformLocation | null> = {};
    return Object.assign(linked, { uniform: (name: string) => (name in cache ? cache[name] : (cache[name] = gl.getUniformLocation(linked, name))) });
  };
  const programs = Object.fromEntries(Object.entries(SHADERS).map(([name, source]) => [name, program(source)])) as Record<keyof typeof SHADERS, Program>;
  if (Object.values(programs).some(linked => !gl.getProgramParameter(linked, gl.LINK_STATUS))) return null;

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  let renderable = true;
  const target = (width: number, height: number): Target => {
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, halfFloat.HALF_FLOAT_OES, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) renderable = false;
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { texture, framebuffer, width, height };
  };
  const velocity = [target(SIM_W, SIM_H), target(SIM_W, SIM_H)];
  const dye = [target(DYE_W, DYE_H), target(DYE_W, DYE_H)];
  const pressure = [target(SIM_W, SIM_H), target(SIM_W, SIM_H)];
  const curl = target(SIM_W, SIM_H), divergence = target(SIM_W, SIM_H);
  const targets = [...velocity, ...dye, ...pressure, curl, divergence];
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!renderable) return null;

  const bind = (linked: Program, name: string, source: Target, unit: number) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, source.texture);
    gl.uniform1i(linked.uniform(name), unit);
  };
  const draw = (linked: Program, into: Target | null) => {
    const width = into ? into.width : canvas.width, height = into ? into.height : canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, into ? into.framebuffer : null);
    gl.viewport(0, 0, width, height);
    gl.uniform2f(linked.uniform('px'), 1 / width, 1 / height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  const splat = (pair: Target[], x: number, y: number, color: number[], radius: number) => {
    const linked = programs.splat;
    gl.useProgram(linked);
    bind(linked, 'T', pair[0], 0);
    gl.uniform3f(linked.uniform('col'), color[0], color[1], color[2]);
    gl.uniform2f(linked.uniform('pt'), x, y);
    gl.uniform1f(linked.uniform('rad'), radius);
    gl.uniform1f(linked.uniform('asp'), canvas.width / Math.max(1, canvas.height));
    draw(linked, pair[1]);
    pair.reverse();
  };

  let previous: [number, number] | null = null;
  const puffs: Array<[number, number]> = [];

  return {
    puff(x, y) { puffs.push([x, y]); },
    resetPointer() { previous = null; },
    clear() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
    step(dt, pointer, color, strength) {
      if (pointer && previous) {
        const dx = pointer[0] - previous[0], dy = pointer[1] - previous[1], distance = Math.hypot(dx, dy);
        if (distance > 0.0004) {
          const count = Math.min(8, Math.ceil(distance / 0.012));
          const amount = (Math.min(1, distance * 45) * 0.22) / count;
          for (let i = 1; i <= count; i++) {
            const x = previous[0] + (dx * i) / count, y = previous[1] + (dy * i) / count;
            splat(velocity, x, y, [(dx * 2600) / count, (dy * 2600) / count, 0], 0.0016);
            splat(dye, x, y, color.map(channel => channel * amount), 0.0011);
          }
        }
      }
      if (pointer) previous = pointer;
      while (puffs.length) { const [x, y] = puffs.pop()!; splat(dye, x, y, color.map(channel => channel * 0.18), 0.004); }

      let linked = programs.curl;
      gl.useProgram(linked); bind(linked, 'V', velocity[0], 0); draw(linked, curl);
      linked = programs.vorticity;
      gl.useProgram(linked); bind(linked, 'V', velocity[0], 0); bind(linked, 'C', curl, 1);
      gl.uniform1f(linked.uniform('dt'), dt); gl.uniform1f(linked.uniform('k'), 14);
      draw(linked, velocity[1]); velocity.reverse();
      linked = programs.divergence;
      gl.useProgram(linked); bind(linked, 'V', velocity[0], 0); draw(linked, divergence);
      linked = programs.fade;
      gl.useProgram(linked); bind(linked, 'T', pressure[0], 0); gl.uniform1f(linked.uniform('k'), 0.8);
      draw(linked, pressure[1]); pressure.reverse();
      linked = programs.pressure;
      gl.useProgram(linked); bind(linked, 'Dv', divergence, 1);
      for (let i = 0; i < 14; i++) { bind(linked, 'Pr', pressure[0], 0); draw(linked, pressure[1]); pressure.reverse(); }
      linked = programs.gradient;
      gl.useProgram(linked); bind(linked, 'Pr', pressure[0], 0); bind(linked, 'V', velocity[0], 1);
      draw(linked, velocity[1]); velocity.reverse();
      linked = programs.advect;
      gl.useProgram(linked);
      gl.uniform2f(linked.uniform('tx'), 1 / SIM_W, 1 / SIM_H); gl.uniform1f(linked.uniform('dt'), dt);
      bind(linked, 'V', velocity[0], 0); bind(linked, 'S', velocity[0], 1); gl.uniform1f(linked.uniform('ds'), 0.35);
      draw(linked, velocity[1]); velocity.reverse();
      bind(linked, 'V', velocity[0], 0); bind(linked, 'S', dye[0], 1); gl.uniform1f(linked.uniform('ds'), 0.75);
      draw(linked, dye[1]); dye.reverse();

      linked = programs.display;
      gl.useProgram(linked); bind(linked, 'D', dye[0], 0); gl.uniform1f(linked.uniform('k'), strength);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      draw(linked, null);
    },
    dispose() {
      for (const item of targets) { gl.deleteTexture(item.texture); gl.deleteFramebuffer(item.framebuffer); }
      for (const linked of Object.values(programs)) gl.deleteProgram(linked);
      gl.deleteBuffer(buffer);
    },
  };
}
