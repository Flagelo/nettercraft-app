/**
 * WebGL2 (GLSL) shaders for the Multiplanar Reconstruction (MPR) and 3D Raymarching Engine (DICOM/NIfTI):
 *  - Step 2: synchronized 2D MPR (Axial, Coronal, Sagittal + Oblique) with WW/WL windowing from usePhysiologyStore,
 *    anisotropic correction in mm and interactive 3D Crosshairs.
 *  - Step 3: Direct Volume Rendering (3D Raymarching) with a 1D Texture Transfer Function (uTransferLut)
 *    coupled to the UI sliders (vascular contrast > 150 HU, bone > 400 HU) and Phong lighting from
 *    central finite differences between adjacent voxels.
 *  - Step 4: Netter Labelmaps (second Data3DTexture) with a Netter watercolor-style overlay + perimeter
 *    outline of the structure under hover.
 */

export const MPR_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export const MPR_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  precision highp sampler3D;

  varying vec2 vUv;

  uniform sampler3D uVolumeTex;
  uniform sampler3D uLabelTex;
  uniform sampler2D uLabelLut;     // 32×1 RGBA LUT with Netter watercolor palette

  uniform int uAxis;               // 0 = Axial (Z), 1 = Coronal (Y), 2 = Sagittal (X)
  uniform vec3 uCrosshair;         // Normalized position [0..1]^3 of the shared 3D Crosshair
  uniform float uObliqueRad;       // Oblique tilt of the cutting plane (rad)
  uniform float uWindowWidth;      // Window Width (WW) read from usePhysiologyStore
  uniform float uWindowLevel;      // Window Level (WL) read from usePhysiologyStore
  uniform int uContrastMode;       // 0 = CT (HU WW/WL), 1 = MRI T1, 2 = MRI T2, 3 = MRI FLAIR
  uniform float uLabelOpacity;     // Base opacity of the Labelmap (0..1)
  uniform int uHoverLabel;         // ID of the anatomical structure under the cursor (0 = none)
  uniform vec3 uVolumeDims;        // Dimensions in voxels [nx, ny, nz]

  vec3 computeSampleCoord(vec2 uv) {
    vec2 centered = uv - 0.5;
    float s = sin(uObliqueRad);
    vec3 p;
    if (uAxis == 0) {
      // Axial (XY at Z = uCrosshair.z)
      p = vec3(uv.x, 1.0 - uv.y, uCrosshair.z + centered.y * s * 0.45);
    } else if (uAxis == 1) {
      // Coronal (XZ at Y = uCrosshair.y)
      p = vec3(uv.x, uCrosshair.y + centered.x * s * 0.45, uv.y);
    } else {
      // Sagittal (YZ at X = uCrosshair.x)
      p = vec3(uCrosshair.x + centered.x * s * 0.45, 1.0 - uv.x, uv.y);
    }
    return p;
  }

  int sampleLabelId(vec3 tc) {
    return int(floor(texture(uLabelTex, tc).r * 255.0 + 0.5));
  }

  float applyModalityContrast(float hu, int labelId) {
    if (uContrastMode == 0) {
      float low = uWindowLevel - 0.5 * uWindowWidth;
      return clamp((hu - low) / max(1.0, uWindowWidth), 0.0, 1.0);
    }
    if (hu < -500.0) return 0.0;
    if (uContrastMode == 1) {
      if (labelId == 12) return 0.12;
      if (hu > 600.0) return 0.08;
      if (hu < -40.0) return 0.88;
      return clamp(0.72 - (hu - 28.0) * 0.012, 0.2, 0.85);
    } else if (uContrastMode == 2) {
      if (labelId == 12) return 0.96;
      if (hu > 600.0) return 0.06;
      return clamp(0.42 + (hu - 25.0) * 0.008, 0.18, 0.78);
    } else {
      if (labelId == 12) return 0.08;
      if (hu > 600.0) return 0.06;
      return clamp(0.48 + (hu - 25.0) * 0.010, 0.20, 0.82);
    }
  }

  void main() {
    vec3 tc = computeSampleCoord(vUv);
    if (any(lessThan(tc, vec3(0.0))) || any(greaterThan(tc, vec3(1.0)))) {
      gl_FragColor = vec4(0.02, 0.03, 0.05, 1.0);
      return;
    }

    float hu = texture(uVolumeTex, tc).r;
    int labelId = sampleLabelId(tc);

    float gray = applyModalityContrast(hu, labelId);
    vec3 color = vec3(gray);

    // Step 4 — Netter Labelmaps & Netter Watercolor-Style Overlay (Ignores generic muscle wall #14 except on hover — Fixes 4.4)
    if (labelId > 0 && (labelId != 14 || labelId == uHoverLabel)) {
      vec4 lut = texture(uLabelLut, vec2((float(labelId) + 0.5) / 32.0, 0.5));
      // Smooth paper/Netter watercolor grain texture
      float paperGrain = 0.94 + 0.06 * sin(vUv.x * 220.0) * cos(vUv.y * 220.0);
      vec3 watercolorTint = lut.rgb * paperGrain;

      // In Lung Window (WW > 1000, WL < -300), preserves the dark aerated parenchyma so as not to wash out the vessels
      bool isLungWindow = (uContrastMode == 0 && uWindowWidth > 1000.0 && uWindowLevel < -300.0);
      float baseTintScale = (isLungWindow && (labelId == 1 || labelId == 2)) ? 0.10 : 0.28;
      float maskAlpha = uLabelOpacity * baseTintScale;

      vec2 duv = vec2(1.4 / max(64.0, uVolumeDims.x));
      int lR = sampleLabelId(computeSampleCoord(vUv + vec2(duv.x, 0.0)));
      int lL = sampleLabelId(computeSampleCoord(vUv - vec2(duv.x, 0.0)));
      int lU = sampleLabelId(computeSampleCoord(vUv + vec2(0.0, duv.y)));
      int lD = sampleLabelId(computeSampleCoord(vUv - vec2(0.0, duv.y)));
      bool isContour = (lR != labelId || lL != labelId || lU != labelId || lD != labelId);

      if (labelId == uHoverLabel) {
        // When the cursor hovers over the mapped structure: enhances watercolor + draws ink/Netter-style outline
        maskAlpha = 0.56;
        if (isContour) {
          watercolorTint = mix(lut.rgb, vec3(0.98, 0.96, 0.90), 0.65);
          maskAlpha = 0.95;
        }
      } else if (isContour && uLabelOpacity > 0.05) {
        // Subtle anatomical outline in Netter atlas style even without hover
        maskAlpha = min(0.68, uLabelOpacity * 0.65);
      }
      color = mix(color, watercolorTint, maskAlpha);
    }

    // Synchronized 3D Crosshair lines with anti-aliasing and sharp central reticle (Fixes 4.3)
    vec2 ch2d;
    vec3 colH;
    vec3 colV;
    if (uAxis == 0) {
      ch2d = vec2(uCrosshair.x, 1.0 - uCrosshair.y);
      colH = vec3(0.15, 0.92, 0.45); // Coronal = Green
      colV = vec3(0.25, 0.72, 1.0);  // Sagittal = Blue
    } else if (uAxis == 1) {
      ch2d = vec2(uCrosshair.x, uCrosshair.z);
      colH = vec3(1.0, 0.32, 0.32);  // Axial = Red
      colV = vec3(0.25, 0.72, 1.0);  // Sagittal = Blue
    } else {
      ch2d = vec2(1.0 - uCrosshair.y, uCrosshair.z);
      colH = vec3(1.0, 0.32, 0.32);  // Axial = Red
      colV = vec3(0.15, 0.92, 0.45); // Coronal = Green
    }

    float dCenter = length(vUv - ch2d);
    if (dCenter > 0.018) {
      float lineH = 1.0 - smoothstep(0.0018, 0.0046, abs(vUv.y - ch2d.y));
      float lineV = 1.0 - smoothstep(0.0018, 0.0046, abs(vUv.x - ch2d.x));
      if (lineH > 0.01) color = mix(color, colH, lineH * 0.88);
      if (lineV > 0.01) color = mix(color, colV, lineV * 0.88);
    } else {
      float ring = 1.0 - smoothstep(0.0015, 0.0040, abs(dCenter - 0.013));
      if (ring > 0.01) color = mix(color, vec3(0.98, 0.96, 0.90), ring * 0.85);
    }

    gl_FragColor = vec4(color, 1.0);
  }
`;

export const RAYMARCH_VERTEX_SHADER = /* glsl */ `
  varying vec3 vLocalPos;
  varying vec3 vWorldPos;
  void main() {
    vLocalPos = position;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const RAYMARCH_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  precision highp sampler3D;

  varying vec3 vLocalPos;
  varying vec3 vWorldPos;

  uniform sampler3D uVolumeTex;
  uniform sampler3D uLabelTex;
  uniform sampler2D uLabelLut;      // 32×1 RGBA LUT with Netter watercolor palette
  uniform sampler2D uTransferLut;   // 1D texture (256×1 RGBA) of the Transfer Function coupled to the HU sliders

  uniform vec3 uCameraLocalPos;     // Camera position in the box's local space [-0.5, +0.5]^3
  uniform int uTransferPreset;      // 0 = CT Angiography, 1 = 3D Bone, 2 = Lung, 3 = MIP
  uniform float uWindowWidth;       // Window Width (WW) synchronized from the store (Fixes 4.1)
  uniform float uWindowLevel;       // Window Level (WL) synchronized from the store (Fixes 4.1)
  uniform vec3 uCrosshair;          // [0..1]^3
  uniform int uClipActive;          // 1 = clips an octant at the 3D Crosshair
  uniform int uHoverLabel;          // Anatomical structure highlighted on hover
  uniform vec3 uVolumeDims;         // [nx, ny, nz]
  uniform vec3 uVoxelSpacing;       // [dx, dy, dz] in mm (for anisotropic physical gradient)

  vec2 intersectUnitBox(vec3 ro, vec3 rd) {
    vec3 boxMin = vec3(-0.5);
    vec3 boxMax = vec3(0.5);
    vec3 invR = 1.0 / rd;
    vec3 tbot = invR * (boxMin - ro);
    vec3 ttop = invR * (boxMax - ro);
    vec3 tmin = min(ttop, tbot);
    vec3 tmax = max(ttop, tbot);
    float t0 = max(max(tmin.x, tmin.y), max(0.0, tmin.z));
    float t1 = min(min(tmax.x, tmax.y), tmax.z);
    return vec2(t0, t1);
  }

  /**
   * Evaluates the 1D Transfer Function (uTransferLut 256×1 texture mapped over [-1000..+1500 HU]),
   * filters the outer body wall (label 14) to reveal the internal organs with surgical sharpness (Fixes 4.2)
   * and applies Netter anatomical chrominance + hover highlight.
   */
  vec4 sampleTransferFunction1D(float hu, int labelId) {
    // Hides the outer muscular/subcutaneous envelope (label 14) in CT Angiography mode to avoid creating a "blobby" haze around the organs
    if (uTransferPreset == 0 && labelId == 14 && uHoverLabel != 14) {
      return vec4(0.0);
    }

    float u = clamp((hu + 1000.0) / 2500.0, 0.0, 1.0);
    vec4 tf = texture(uTransferLut, vec2(u, 0.5));

    // In CT Angiography mode (preset 0), combines the 1D transfer function with the Netter chromatic identity of the internal organs
    if (uTransferPreset == 0 && labelId > 0 && labelId != 14) {
      vec4 lut = texture(uLabelLut, vec2((float(labelId) + 0.5) / 32.0, 0.5));
      if (labelId == 10 || labelId == 15) {
        // Liver (Couinaud Dome VII/VIII and Segment VI) visible with translucent parenchymal texture
        tf.rgb = mix(tf.rgb, lut.rgb, 0.82);
        tf.a = max(tf.a, 0.11);
      } else if (labelId == 3 || labelId == 5 || labelId == 6 || labelId == 7 || labelId == 16) {
        // Cardiac chambers, Aorta, Pulmonary Trunk and IVC
        tf.rgb = mix(tf.rgb, lut.rgb, 0.65);
        tf.a = max(tf.a, 0.24);
      }
    }

    if (uHoverLabel > 0 && labelId == uHoverLabel) {
      vec4 lut = texture(uLabelLut, vec2((float(labelId) + 0.5) / 32.0, 0.5));
      tf.rgb = mix(tf.rgb, lut.rgb, 0.90) * 1.25;
      tf.a = max(tf.a, 0.48);
    }
    return tf;
  }

  /**
   * Step 3 — Local Gradient by Central Finite Differences between Adjacent Voxels,
   * weighted by the anisotropic physical spacing (uVoxelSpacing in mm) for Phong lighting
   * and edge enhancement (gradient magnitude opacity modulation). Returns vec4(normal.xyz, gradMag).
   */
  vec4 computeGradientAndMagnitude(vec3 tc) {
    vec3 stepTex = 1.0 / max(vec3(32.0), uVolumeDims);
    float gx = (texture(uVolumeTex, tc + vec3(stepTex.x, 0.0, 0.0)).r -
                texture(uVolumeTex, tc - vec3(stepTex.x, 0.0, 0.0)).r) / max(0.1, uVoxelSpacing.x);
    float gy = (texture(uVolumeTex, tc + vec3(0.0, stepTex.y, 0.0)).r -
                texture(uVolumeTex, tc - vec3(0.0, stepTex.y, 0.0)).r) / max(0.1, uVoxelSpacing.y);
    float gz = (texture(uVolumeTex, tc + vec3(0.0, 0.0, stepTex.z)).r -
                texture(uVolumeTex, tc - vec3(0.0, 0.0, stepTex.z)).r) / max(0.1, uVoxelSpacing.z);
    vec3 g = vec3(-gx, -gy, -gz);
    float mag = length(g);
    return vec4(normalize(g + vec3(1e-5)), mag);
  }

  // Stochastic per-pixel jitter to suppress wood-grain artifacts in the raymarching
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    vec3 ro = uCameraLocalPos;
    vec3 rd = normalize(vLocalPos - ro);
    vec2 hit = intersectUnitBox(ro, rd);
    if (hit.x >= hit.y) discard;

    const int STEPS = 148;
    float dt = (hit.y - hit.x) / float(STEPS);
    float jitter = (hash12(gl_FragCoord.xy) - 0.5) * dt;
    float t = max(hit.x, hit.x + jitter);

    vec3 accumColor = vec3(0.0);
    float accumAlpha = 0.0;
    float mipMaxHu = -1000.0;

    // Light and view directions for directional Phong shading + Rim Lighting
    vec3 lightDir = normalize(vec3(0.55, 0.78, 0.62));
    vec3 fillLightDir = normalize(vec3(-0.6, -0.3, 0.5));
    vec3 viewDir = -rd;

    for (int i = 0; i < STEPS; i++) {
      vec3 pLocal = ro + rd * t;
      vec3 tc = pLocal + 0.5;

      bool clipped = (uClipActive == 1) &&
        (tc.x > uCrosshair.x && tc.y < uCrosshair.y && tc.z > uCrosshair.z);

      if (!clipped) {
        float hu = texture(uVolumeTex, tc).r;
        if (uTransferPreset == 3) {
          if (hu > mipMaxHu) mipMaxHu = hu;
        } else if (hu > -880.0) {
          int labelId = int(floor(texture(uLabelTex, tc).r * 255.0 + 0.5));
          vec4 sampleRgba = sampleTransferFunction1D(hu, labelId);
          if (sampleRgba.a > 0.003) {
            // Phong Lighting + Surface Enhancement by Gradient Magnitude (Fixes 4.2)
            vec4 gradInfo = computeGradientAndMagnitude(tc);
            vec3 normal = gradInfo.xyz;
            float gradMag = gradInfo.w;
            float edgeEnhance = clamp(0.35 + gradMag / 95.0, 0.35, 1.85);

            float ambient = 0.28;
            float diffMain = max(0.0, dot(normal, lightDir)) * 0.68 + max(0.0, -dot(normal, lightDir)) * 0.18;
            float diffFill = max(0.0, dot(normal, fillLightDir)) * 0.22;
            vec3 halfVec = normalize(lightDir + viewDir);
            float spec = pow(max(0.0, dot(normal, halfVec)), 28.0) * 0.36 * clamp(gradMag / 120.0, 0.0, 1.0);
            float rim = pow(1.0 - max(0.0, abs(dot(normal, viewDir))), 3.0) * 0.18;

            vec3 shaded = sampleRgba.rgb * (ambient + diffMain + diffFill + rim) + vec3(spec);

            // Front-to-back compositing with surface weighting (avoids "blobby" look)
            float effectiveAlpha = clamp(sampleRgba.a * edgeEnhance, 0.0, 0.98);
            float stepAlpha = 1.0 - pow(1.0 - effectiveAlpha, dt * 88.0);
            accumColor += (1.0 - accumAlpha) * stepAlpha * shaded;
            accumAlpha += (1.0 - accumAlpha) * stepAlpha;
            if (accumAlpha > 0.97) break;
          }
        }
      }
      t += dt;
    }

    if (uTransferPreset == 3) {
      float low = uWindowLevel - 0.5 * max(40.0, uWindowWidth);
      float mipVal = clamp((mipMaxHu - low) / max(40.0, uWindowWidth), 0.0, 1.0);
      gl_FragColor = vec4(vec3(mipVal), mipVal > 0.02 ? 1.0 : 0.0);
      return;
    }

    if (accumAlpha < 0.01) discard;
    gl_FragColor = vec4(accumColor, accumAlpha);
  }
`;
