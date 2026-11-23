import * as THREE from 'three';

/**
  * Procedural myocardial shader module for the ventricular segments of CardioCraft 3D.
  * Refined v2: continuous oblique helical pattern without artificial sinusoidal striations,
  * low organic contrast and soft micro-roughness, preserving 100% of the clinical colors.
 *
  * Strict invariants:
  * - Native PBR pipeline (Cook-Torrance, directional lights, ambient, shadows, tonemapping).
  * - Direct multiplication on diffuseColor.rgb, keeping active all the dynamic modifications
  *   of material.color in useFrame (motility, DA ischemia, depolarization and segment selection).
  * - Deterministic customProgramCacheKey: single compilation in the shared GPU cache.
  * - Zero allocations per frame (stable uniforms kept by reference).
 */

export interface MyocardialShaderUniforms {
  uMyoIntensity: { value: number };
  uMyoScale: { value: number };
  uMyoRoughnessMod: { value: number };
}

/**
  * Local activation flag for instant rollback if needed.
 */
export const ENABLE_PROCEDURAL_MYOCARDIUM = true;

/**
  * Default stable uniforms shared among the ventricular segments.
 */
export const DEFAULT_MYOCARDIAL_UNIFORMS: MyocardialShaderUniforms = {
  uMyoIntensity: { value: 0.80 },
  uMyoScale: { value: 26.0 },
  uMyoRoughnessMod: { value: 1.0 },
};

export const MYOCARDIAL_PROGRAM_CACHE_KEY = 'myocardial_procedural_aha_v2_refined';

/**
  * Attaches the procedural myocardial extension to an already cloned MeshStandardMaterial.
  * Applied exclusively to the ventricular submeshes of the heart.
 */
export function attachProceduralMyocardiumShader(
  material: THREE.MeshStandardMaterial,
  uniforms: MyocardialShaderUniforms = DEFAULT_MYOCARDIAL_UNIFORMS
): void {
  if (!ENABLE_PROCEDURAL_MYOCARDIUM || !material) {
    return;
  }

  material.customProgramCacheKey = () => MYOCARDIAL_PROGRAM_CACHE_KEY;

  material.onBeforeCompile = (shader: THREE.WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uMyoIntensity = uniforms.uMyoIntensity;
    shader.uniforms.uMyoScale = uniforms.uMyoScale;
    shader.uniforms.uMyoRoughnessMod = uniforms.uMyoRoughnessMod;

    // 1. Varying injection in the Vertex Shader
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
      varying vec3 vMyoWorldPos;
      varying vec3 vMyoWorldNormal;`
    );

    shader.vertexShader = shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
      vMyoWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      vMyoWorldNormal = normalize(mat3(modelMatrix) * normal);`
    );

    // 2. Injection of functions and uniforms in the Fragment Shader
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
      uniform float uMyoIntensity;
      uniform float uMyoScale;
      uniform float uMyoRoughnessMod;
      varying vec3 vMyoWorldPos;
      varying vec3 vMyoWorldNormal;

      // Continuous deterministic 3D hash and noise in world coordinates
      float myoHash(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }

      float myoNoise3D(vec3 x) {
        vec3 p = floor(x);
        vec3 f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(myoHash(p + vec3(0,0,0)), myoHash(p + vec3(1,0,0)), f.x),
              mix(myoHash(p + vec3(0,1,0)), myoHash(p + vec3(1,1,0)), f.x), f.y),
          mix(mix(myoHash(p + vec3(0,0,1)), myoHash(p + vec3(1,0,1)), f.x),
              mix(myoHash(p + vec3(0,1,1)), myoHash(p + vec3(1,1,1)), f.x), f.y), f.z);
      }`
    );

    // 3. Soft organic albedo modulation (color_fragment) with oblique helical flow
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      // Continuous oblique myocardial helical projection
      vec3 myoP = vMyoWorldPos * uMyoScale;
      vec3 myoHelix = vec3(
        myoP.x * 0.72 + myoP.y * 0.68,
        myoP.y * 0.72 - myoP.x * 0.68,
        myoP.z * 1.15
      );

      // Continuous myocardial bundles without periodic striations
      float myoFibers = myoNoise3D(vec3(myoHelix.x * 1.6, myoHelix.y * 6.5, myoHelix.z * 1.6));
      float myoFine = myoNoise3D(vec3(myoHelix.x * 5.0, myoHelix.y * 15.0, myoHelix.z * 5.0));
      float myoPattern = 0.68 * myoFibers + 0.32 * myoFine;

      // Subtle organic modulation (amplitude 0.18, eliminating artificial streaks)
      float myoMod = 1.0 + (myoPattern - 0.5) * 0.18 * uMyoIntensity;
      vec3 myoTint = vec3(1.01, 0.97, 0.95);
      vec3 procFactor = mix(vec3(1.0), myoTint * myoMod, clamp(uMyoIntensity, 0.0, 1.5));
      diffuseColor.rgb *= procFactor;`
    );

    // 4. Soft PBR micro-roughness modulation
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
      roughnessFactor = clamp(roughnessFactor + (myoPattern - 0.5) * 0.08 * uMyoRoughnessMod * uMyoIntensity, 0.15, 0.85);`
    );
  };
}
