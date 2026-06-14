import React, { useRef, useEffect } from 'react';

interface LiquidGlassHeaderProps {
  theme: 'dark' | 'light' | 'oled';
}

const vertexShaderSource = `
  attribute vec2 a_position;
  varying vec2 v_uv;
  void main() {
    v_uv = vec2(a_position.x, -a_position.y) * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const fragmentShaderSource = `
  precision mediump float;
  uniform float u_dpr;
  uniform vec2 u_resolution;
  uniform vec2 u_mouse;
  uniform float u_time;
  uniform float u_hover;
  uniform float u_scroll;
  uniform float u_theme; // 0.0 = dark, 1.0 = light, 2.0 = oled
  varying vec2 v_uv;

  // Swirling procedural liquid plasma
  vec3 getProceduralBackground(vec2 uv, float time, float theme, float scroll) {
    // Apply scroll-based vertical offset for parallax depth
    vec2 st = uv + vec2(0.0, scroll * 0.12);
    
    // Domain warping using multiple sine waves
    vec2 q = st;
    q.x += sin(time * 0.15 + q.y * 2.5) * 0.4;
    q.y += cos(time * 0.20 + q.x * 2.5) * 0.4;

    vec2 r = st;
    r.x += sin(time * 0.10 + q.y * 3.0) * 0.5;
    r.y += cos(time * 0.25 + q.x * 2.0) * 0.3;

    // Swirling frequency mixing
    float f = sin(r.x * 3.5 + r.y * 3.5 + time * 0.4) * 0.5 + 0.5;
    f = mix(f, cos(q.x * 2.0 - q.y * 2.0 - time * 0.3) * 0.5 + 0.5, 0.4);

    if (theme == 1.0) {
      // Light Theme: soft slate-silvers, golds, whites, and light ice-blues
      vec3 colBase = vec3(0.97, 0.98, 0.99); 
      vec3 colBlue = vec3(0.91, 0.94, 0.97); 
      vec3 colGold = vec3(0.98, 0.95, 0.88); 
      vec3 color = mix(colBase, colBlue, f);
      color = mix(color, colGold, dot(q, r) * 0.3 + 0.3);
      return color;
    } else if (theme == 2.0) {
      // OLED Theme: pure black with very subtle dark slate and deep indigo highlights
      vec3 colBase = vec3(0.0); 
      vec3 colSlate = vec3(0.015, 0.02, 0.035); 
      vec3 colIndigo = vec3(0.01, 0.015, 0.025); 
      vec3 color = mix(colBase, colSlate, f * 0.25);
      color = mix(color, colIndigo, dot(q, r) * 0.15 + 0.1);
      return color;
    } else {
      // Dark Theme: deep navy base, emerald-teal accents, and rich indigo waves
      vec3 colBase = vec3(0.01, 0.02, 0.08); 
      vec3 colEmerald = vec3(0.03, 0.11, 0.09); 
      vec3 colIndigo = vec3(0.06, 0.04, 0.15); 
      vec3 color = mix(colBase, colEmerald, f);
      color = mix(color, colIndigo, dot(q, r) * 0.5 + 0.5);
      return color;
    }
  }

  // Smooth blur calculated directly in the shader
  vec3 blurBackground(vec2 uv, float time, float theme, float scroll) {
    vec3 result = vec3(0.0);
    float total = 0.0;
    float radius = 3.0;
    for (int x = -2; x <= 2; x++) {
      for (int y = -2; y <= 2; y++) {
        // Blur step size
        vec2 offset = vec2(float(x), float(y)) * 0.02;
        float weight = exp(-(float(x * x + y * y)) / (2.0 * radius));
        result += getProceduralBackground(uv + offset, time, theme, scroll) * weight;
        total += weight;
      }
    }
    return result / total;
  }

  float roundedBoxSDF(vec2 p, vec2 b, float r) {
    vec2 d = abs(p) - b + vec2(r);
    return length(max(d, 0.0)) - r;
  }

  void main() {
    vec2 pixelUV = (v_uv * u_resolution) / u_dpr;
    vec2 center = u_resolution * 0.5;
    vec2 size = u_resolution * 0.5 - vec2(1.5); // inset by border weight
    float cornerRadius = 16.0; // matching rounded-2xl

    // Distance to borders of the header
    float dist = roundedBoxSDF(pixelUV - center, size, cornerRadius);

    // Apply distortion wave centered at the mouse coordinates if hovering
    vec2 warpedUV = v_uv;
    vec2 toMouse = pixelUV - u_mouse;
    float mouseDist = length(toMouse);
    float distortionRadius = 90.0;

    if (mouseDist < distortionRadius && u_hover > 0.0) {
      float strength = 0.035 * u_hover;
      float falloff = 1.0 - smoothstep(0.0, distortionRadius, mouseDist);
      // Ripple distortion wave
      vec2 distortion = normalize(toMouse) * sin(mouseDist * 0.06) * strength * falloff;
      warpedUV += distortion;
    }

    // Blend standard fluid background with blurred version to create frosted glass look
    vec3 baseCol = getProceduralBackground(warpedUV, u_time, u_theme, u_scroll);
    vec3 blurCol = blurBackground(warpedUV, u_time, u_theme, u_scroll);
    
    // Mix ratio: 70% blurred, 30% clean sharp fluid
    vec3 glassColor = mix(baseCol, blurCol, 0.70);

    // Add subtle ambient brightness highlight inside the glass card
    float highlight = 1.0 - smoothstep(0.0, 150.0, pixelUV.y);
    float highlightAmt = u_theme == 1.0 ? 0.02 : 0.08;
    glassColor += vec3(highlight * highlightAmt);

    // 1px/2px Premium edge border glow
    float border = 1.0 - smoothstep(0.0, 1.5, abs(dist));
    vec3 borderCol = u_theme == 1.0 ? vec3(0.0) : vec3(1.0);
    float borderOpacity = u_theme == 1.0 ? 0.12 : 0.06;
    glassColor = mix(glassColor, borderCol, border * borderOpacity);

    gl_FragColor = vec4(glassColor, 0.75);
  }
`;

export const LiquidGlassHeader: React.FC<LiquidGlassHeaderProps> = ({ theme }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mouseRef = useRef({ x: 0, y: 0, targetX: 0, targetY: 0 });
  const hoverRef = useRef({ intensity: 0, targetIntensity: 0 });
  const scrollRef = useRef({ offset: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = (canvas.getContext('webgl', { antialias: true }) || canvas.getContext('experimental-webgl', { antialias: true })) as WebGLRenderingContext | null;
    if (!gl) {
      console.warn('WebGL is not supported in this browser.');
      return;
    }

    // Resize canvas to match the parent header element
    const resizeCanvas = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      gl.viewport(0, 0, canvas.width, canvas.height);
    };

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // Shader compilation utility
    const compileShader = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Shader compile error:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vertexShader = compileShader(gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource);

    if (!vertexShader || !fragmentShader) return;

    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Shader program linking error:', gl.getProgramInfoLog(program));
      return;
    }

    gl['useProgram'](program);

    // Setup coordinates buffer (full screen quad)
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1,
         1, -1,
        -1,  1,
        -1,  1,
         1, -1,
         1,  1,
      ]),
      gl.STATIC_DRAW
    );

    const positionLocation = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    // Get uniform locations
    const uResolution = gl.getUniformLocation(program, 'u_resolution');
    const uMouse = gl.getUniformLocation(program, 'u_mouse');
    const uTime = gl.getUniformLocation(program, 'u_time');
    const uHover = gl.getUniformLocation(program, 'u_hover');
    const uScroll = gl.getUniformLocation(program, 'u_scroll');
    const uTheme = gl.getUniformLocation(program, 'u_theme');
    const uDpr = gl.getUniformLocation(program, 'u_dpr');

    // Handle mouse event listeners relative to the header element
    const header = canvas.parentElement;
    
    const handleMouseMove = (e: MouseEvent) => {
      if (!header) return;
      const rect = header.getBoundingClientRect();
      mouseRef.current.targetX = e.clientX - rect.left;
      mouseRef.current.targetY = e.clientY - rect.top;
    };

    const handleMouseEnter = () => {
      hoverRef.current.targetIntensity = 1.0;
    };

    const handleMouseLeave = () => {
      hoverRef.current.targetIntensity = 0.0;
    };

    if (header) {
      header.addEventListener('mousemove', handleMouseMove);
      header.addEventListener('mouseenter', handleMouseEnter);
      header.addEventListener('mouseleave', handleMouseLeave);
      
      // Initialize mouse coordinates in the center
      const rect = header.getBoundingClientRect();
      mouseRef.current.targetX = rect.width / 2;
      mouseRef.current.targetY = rect.height / 2;
      mouseRef.current.x = rect.width / 2;
      mouseRef.current.y = rect.height / 2;
    }

    // Scroll tracker listener (detects scrolling content container)
    const handleScroll = (e: Event) => {
      const target = e.target as HTMLElement;
      if (target) {
        scrollRef.current.offset = target.scrollTop;
      }
    };

    // Find and attach to the main scroll container
    const scrollContainer = document.querySelector('.overflow-y-auto');
    if (scrollContainer) {
      scrollContainer.addEventListener('scroll', handleScroll);
    }

    // Render loop variables
    let animationFrameId: number;
    let startTime = performance.now();
    let lastTime = performance.now();

    const render = (now: number) => {
      const delta = (now - lastTime) / 1000;
      lastTime = now;

      // Inertia interpolation for smooth physical reactions
      const speed = 7.0;
      mouseRef.current.x += (mouseRef.current.targetX - mouseRef.current.x) * speed * delta;
      mouseRef.current.y += (mouseRef.current.targetY - mouseRef.current.y) * speed * delta;
      hoverRef.current.intensity += (hoverRef.current.targetIntensity - hoverRef.current.intensity) * speed * delta;

      // Redraw scene
      resizeCanvas();
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      // Pass uniforms
      const dpr = window.devicePixelRatio || 1;
      gl.uniform1f(uDpr, dpr);
      gl.uniform2f(uResolution, canvas.width, canvas.height);
      gl.uniform2f(uMouse, mouseRef.current.x, mouseRef.current.y);
      gl.uniform1f(uTime, (now - startTime) / 1000);
      gl.uniform1f(uHover, hoverRef.current.intensity);
      gl.uniform1f(uScroll, scrollRef.current.offset);
      
      let themeVal = 0.0; // dark
      if (theme === 'light') themeVal = 1.0;
      else if (theme === 'oled') themeVal = 2.0;
      gl.uniform1f(uTheme, themeVal);

      gl.drawArrays(gl.TRIANGLES, 0, 6);

      animationFrameId = requestAnimationFrame(render);
    };

    animationFrameId = requestAnimationFrame(render);

    // Cleanup resources on unmount
    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', resizeCanvas);
      if (header) {
        header.removeEventListener('mousemove', handleMouseMove);
        header.removeEventListener('mouseenter', handleMouseEnter);
        header.removeEventListener('mouseleave', handleMouseLeave);
      }
      if (scrollContainer) {
        scrollContainer.removeEventListener('scroll', handleScroll);
      }
      gl.deleteBuffer(positionBuffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
    };
  }, [theme]);

  return (
    <div ref={containerRef} className="absolute inset-0 z-0 rounded-2xl overflow-hidden pointer-events-none">
      <canvas ref={canvasRef} className="absolute inset-0 block w-full h-full pointer-events-none" />
    </div>
  );
};

export default LiquidGlassHeader;
