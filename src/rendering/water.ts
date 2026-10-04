import * as THREE from 'three';

/** Shared clock for animated water (seconds). */
export const waterTime = { value: 0 };

/**
 * Adds a cheap animated shimmer to a standard water material: two moving
 * sine ripple fields in world space scale the surface brightness by a few percent.
 * No textures, a handful of ALU ops per fragment.
 */
export function shimmerWater(mat: THREE.MeshStandardMaterial, scale = 1): THREE.MeshStandardMaterial {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWaterTime = waterTime;
    shader.uniforms.uWaterScale = { value: scale };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWaterXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWaterXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWaterXZ;\nuniform float uWaterTime;\nuniform float uWaterScale;')
      .replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
        {
          vec2 p = vWaterXZ * uWaterScale;
          float w = sin(p.x * 0.9 + uWaterTime * 0.8) * sin(p.y * 0.7 - uWaterTime * 0.6)
                  + 0.5 * sin((p.x + p.y) * 2.1 + uWaterTime * 1.7);
          // relative brightening keeps the hue and stays subtle in the dark
          gl_FragColor.rgb *= 1.0 + 0.09 * w;
        }`,
      );
  };
  mat.customProgramCacheKey = () => `water-shimmer-${scale}`;
  return mat;
}
