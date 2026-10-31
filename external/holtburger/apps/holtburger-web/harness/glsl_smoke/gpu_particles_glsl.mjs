// harness/glsl_smoke/gpu_particles_glsl.mjs — node half of the `?gpuParticles`
// (R3-7a) SwiftShader smoke: runs the scenarios flag off and flag on through the
// real ParticleManager and prints the page's input as JSON on stdout (the
// production GLSL header, the record / row tables, every gpu instance with its
// flag-off CPU reference, the S5 specials, the large-clock replays). The data
// and the verdict code live in tests/helpers/gpu_particles_smoke_data.mjs.
// Spawned by gpu_particles_smoke.mjs (cwd = apps/holtburger-web).
import { buildSmokeData } from "../../tests/helpers/gpu_particles_smoke_data.mjs";

const data = await buildSmokeData();
process.stdout.write(JSON.stringify(data));
