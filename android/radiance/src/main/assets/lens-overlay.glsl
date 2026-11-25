// Portable GLSL/AGSL optics. No images or recorded animation are used.
// Wave animation adapted from ios-siri-animation (MIT); see third-party-siri-animation.txt.
vec3 voiceWaves(vec2 p, float pixel, float time, float energy) {
    float nx = p.x/2.30 + 0.5;
    if (nx <= 0.0 || nx >= 1.0) return vec3(0.0);
    float envelope = pow(sin(nx*3.141592654), 2.8);
    float fade = smoothstep(0.0,0.42,nx)*(1.0-smoothstep(0.58,1.0,nx));
    float clock = time*(-2.7);
    // Preserve the accepted animation; the existing audio envelope only scales its height.
    float height = 0.110*envelope*(0.35+0.65*energy);
    vec4 amplitudes = vec4(1.30,0.70,1.22,0.72);
    vec4 thicknesses = vec4(1.35,0.72,1.30,0.75);
    vec4 phases = vec4(0.00,0.38,0.75,1.15);
    vec3 light = vec3(0.0);
    for (int i = 0; i < 4; i++) {
        vec3 color = i == 0 ? vec3(0.0,0.1843137255,1.0)
            : i == 1 ? vec3(0.0,1.0,0.8705882353)
            : i == 2 ? vec3(0.9803921569,0.1215686275,0.1215686275)
            : vec3(1.0,0.5764705882,0.0509803922);
        float harmonic = 1.0+0.12*sin(clock*1.5+float(i)*1.3);
        float amplitude = amplitudes[i]*harmonic*height;
        float waveY = sin(p.x*1.6+clock-4.1*phases[i])*amplitude;
        // Upstream uses downward-positive coordinates and a 53-unit half-width.
        float distance = abs(-p.y+0.5/53.0+waveY);
        float thickness = 0.056*envelope*thicknesses[i];
        float density = pow(clamp(thickness/(distance+thickness*0.32),0.0,1.0),1.5);
        light += density*color*fade;
    }
    // With four layers, upstream's density > 7.2 hot-core branch is unreachable.
    return light*1.15;
}

vec4 voiceLens(vec2 p, float pixel, float time, float energy, float shape) {
    const float height = 0.744;
    const float depth = 0.42;
    float power = pow(abs(p.x),shape) + pow(abs(p.y/height),shape);
    float shell = pow(power,1.0/shape);
    float coverage = 1.0-smoothstep(1.0-pixel,1.0+pixel,shell);
    if (coverage <= 0.0) return vec4(0.0);
    float z = depth*sqrt(max(0.0001,1.0-min(power,0.9999)));
    vec3 normal = normalize(vec3(shape*sign(p.x)*pow(abs(p.x),shape-1.0),
        shape/height*sign(p.y)*pow(abs(p.y/height),shape-1.0),2.0*z/(depth*depth)));
    vec3 transmitted = refract(vec3(0.0,0.0,-1.0),normal,1.0/1.43);
    vec2 wavePoint = p+transmitted.xy*(z/max(-transmitted.z,0.1));
    vec3 radiance = voiceWaves(wavePoint,pixel*0.85,time,energy);
    vec3 glow = clamp(radiance,vec3(0.0),vec3(1.0));
    float strength = max(radiance.r,max(radiance.g,radiance.b));
    float fresnel = 0.031+0.969*pow(1.0-clamp(normal.z,0.0,1.0),5.0);
    float cap = smoothstep(-0.01,0.34,p.y);
    float bodyAlpha = min(0.94,0.42+0.52*cap+0.20*fresnel);
    vec3 reflected = reflect(vec3(0.0,0.0,-1.0),normal);
    float studio = 0.10+0.80*pow(max(0.0,dot(reflected,normalize(vec3(-0.4,-0.7,0.8)))),10.0);
    vec3 glass = mix(vec3(0.12,0.13,0.16),vec3(0.004,0.006,0.008),cap);
    glass *= 0.65+0.35*normal.z;
    glass += vec3(0.81,0.86,0.90)*studio*(0.06+0.65*fresnel)*(1.0-cap*0.85);
    float volume = exp(-pow(p.x/0.35,2.0)-pow((p.y+0.43)/0.45,2.0))*(0.12+0.42*energy)*(1.0-cap);
    glass += vec3(1.0,0.80,0.95)*volume/bodyAlpha;
    float rim = exp(-pow((shell-0.994)/max(pixel,0.004),2.0));
    glass += vec3(0.85,0.88,0.92)*rim*(0.40+0.60*fresnel)*(1.0-cap*0.85);
    vec3 tint = clamp(glass*exp(-2.0*strength)+glow,0.0,1.0);
    float alpha = mix(bodyAlpha,1.0,min(strength*0.65,1.0));
    alpha = max(alpha,0.85*rim*(1.0-cap*0.5));
    return vec4(tint,coverage*alpha);
}
