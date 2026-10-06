import { GLSL_PERTURB, kit, type Kit } from './TexKits';

/**
 * Procedural ground surfaces for the Tianhe street level (no texture files): the plain Blender colours of
 * roads, pavements, kerbs and lawns get detail that holds up at a metre from the camera and fades to the
 * mean before it can alias.
 *
 *   asphalt   aggregate speckle, 3 m mottling, rectangular repair patches and wheel-track polish in road
 *             space (u metres along, v metres across), oil drips down lane centres, sealed cracks
 *   slab      granite slabs 0.6 x 0.3 m in running bond (world grid), grout, per-slab tone, dirt
 *   brick     red clay pavers 0.2 x 0.1 m along the footway (road space)
 *   granite   kerbs, quays, steps: salt-and-pepper grain
 *   grass     two-scale colour variation, dry patches
 *   concrete  bridge decks: formwork joints, stains
 *   marking   road paint worn through along the wheel tracks
 *
 * All of them respond to GZ.uWet (0 dry .. 1 soaked): darker, glossy, puddles in the low spots.
 * Output: albedo in the color chunk, gzR (roughness) and gzH (height, metres) for a derivative bump.
 */
export type SurfaceKind = 'asphalt' | 'asphalt_world' | 'slab' | 'brick' | 'granite' | 'grass' | 'concrete' | 'marking' | 'plaza' | 'court'
  | 'mall_floor' | 'mall_ceiling' | 'court_north';

export function surfaceKind(name: string): SurfaceKind | null {
  if (/Huacheng \| plaza/.test(name)) return 'plaza';
  if (/Huacheng \| court stone/.test(name)) return 'court';
  if (/Huacheng \| north court stone/.test(name)) return 'court_north';
  if (/GZ Mall \| floor tile/.test(name)) return 'mall_floor';
  if (/GZ Mall \| ceiling grille/.test(name)) return 'mall_ceiling';
  if (/marking/i.test(name)) return 'marking';
  if (/asphalt (major|minor)/i.test(name)) return 'asphalt';
  if (/asphalt/i.test(name)) return 'asphalt_world';
  if (/footway paving/i.test(name)) return 'brick';
  if (/Ground \| paving/i.test(name)) return 'slab';
  if (/kerb|quay|steps/i.test(name)) return 'granite';
  if (/lawn/i.test(name)) return 'grass';
  if (/bridge concrete/i.test(name)) return 'concrete';
  return null;
}

/** The baked texture set a surface kind uses (null: procedural detail only). */
export function surfaceKit(kind: SurfaceKind): Kit | null {
  switch (kind) {
    case 'asphalt': case 'asphalt_world': return kit('city_asphalt');
    case 'slab': case 'plaza': case 'court': case 'court_north': return kit('city_slab');
    case 'brick': return kit('city_brick');
    case 'grass': return kit('city_grass');
    default: return null;
  }
}

export const SURFACE_DECL = /* glsl */`
  uniform float uWet;
  uniform sampler2D tKA, tKN, tKO;
  float gzR; float gzH;
  vec2 gzTuv; vec3 gzMapN; float gzHasMap; vec3 gzEmit;
  ${GLSL_PERTURB}
  float gzSpeck(vec2 p, float scale, float seed) {                 // cell noise, faded to 0.5 when sub-pixel
    vec2 q = p * scale;
    float w = max(fwidth(q.x), fwidth(q.y));
    return mix(0.5, gzHash3(vec3(floor(q), seed)), clamp(1.4 - w, 0.0, 1.0));
  }
  float gzLine(float d, float width, float px) {                  // anti-aliased line of half-width width
    return 1.0 - smoothstep(width, width + px * 1.5, d);
  }
`;

const WET = /* glsl */`
  // rain: darker and glossier; puddles gather in the low-frequency hollows
  float gzPud = smoothstep(0.56, 0.64, gzFbm(vGzWorld.xz * 0.16 + 3.0)) * smoothstep(0.35, 0.8, uWet);
  diffuseColor.rgb *= mix(1.0, POROUS, uWet);
  gzR = mix(gzR, 0.14, uWet * 0.85);
  gzR = mix(gzR, 0.03, gzPud);
  gzH *= 1.0 - gzPud;
  diffuseColor.rgb *= 1.0 - gzPud * 0.25;
`;

function wet(porous: number): string {
  return WET.replace('POROUS', porous.toFixed(3));
}

const fx = (x: number) => x.toFixed(4);

/** Sample a kit at uv (metres): kA = albedo / mean (1 on average), kO = ORM, the map normal for SURFACE_NORMAL. */
function kitSample(k: Kit, uv: string, nstr = 1): string {
  return /* glsl */`
      gzTuv = (${uv}) / vec2(${fx(k.tile[0])}, ${fx(k.tile[1])});
      vec3 kA = texture2D(tKA, gzTuv).rgb / vec3(${k.mean.map((m) => fx(Math.max(m, 0.02))).join(', ')});
      vec3 kO = texture2D(tKO, gzTuv).rgb;
      gzMapN = texture2D(tKN, gzTuv).xyz * 2.0 - 1.0; gzMapN.xy *= ${fx(nstr)}; gzHasMap = 1.0;`;
}

/**
 * Huacheng Square (gz_huacheng): the plaza's granite, its lattice of inset glass strips, the eye inlay between the
 * twin towers. bp = Blender (x, y). Strips: two families of diagonals across the promenade (x -28..+23, south of the
 * towers), 0.28 m of pale green glass by day; at night LEDs in a slow travelling rainbow (the photos: a strip of
 * colour in the paving). The eye: concentric bands in golden-brown and grey granite, an almond line, a dark pupil
 * ringed in brass with a cyan LED ring at night.
 */
const PLAZA = (k: Kit) => /* glsl */`
      vec2 bp = vec2(wp.x, -wp.y);
      ${kitSample(k, 'bp * 0.5', 1.0)}
      // 1.2 x 0.6 m pale granite; big panels a shade apart
      vec2 pan = floor(bp / vec2(9.6, 9.6));
      float pt = gzHash3(vec3(pan, 3.3));
      diffuseColor.rgb *= kA * (0.975 + 0.035 * pt) * (0.92 + 0.14 * gzFbm(bp * 0.09)) * mix(1.0, kO.r, 0.8);
      gzR = kO.g * 0.9;
      // --- the strips (promenade only)
      float band = smoothstep(29.0, 26.0, abs(bp.x + 2.5)) * smoothstep(-95.0, -110.0, bp.y) * smoothstep(-575.0, -545.0, bp.y);
      float ca = 0.8480, sa = 0.5299;                          // 32 degrees off the axis
      float s1 = dot(bp, vec2(sa, ca)), s2 = dot(bp, vec2(-sa, ca));
      float d1 = abs(fract(s1 / 23.0 + 0.5) - 0.5) * 23.0, d2 = abs(fract(s2 / 23.0 + 0.5) - 0.5) * 23.0;
      float dx = min(abs(bp.x + 28.0), abs(bp.x - 23.0));      // and one along each edge
      float dmin = min(min(d1, d2), dx);
      float aa = fwidth(s1) * 1.2;
      // 0.28 m of glass is under a pixel past ~40 m: hold it at about a pixel wide (a little fainter) so the lattice
      // still reads across the promenade from the far end and from above
      float shw = clamp(aa * 1.1, 0.14, 0.45);
      float strip = band * (1.0 - smoothstep(shw - aa, shw + aa, dmin)) * mix(1.0, 0.85, smoothstep(0.14, 0.45, shw))
                  * clamp(0.7 / max(aa, 0.01), 0.0, 1.0);         // toward the horizon a pixel spans metres: fade, no teal smear
      // a stainless frame either side of the glass (reads at a distance; the glass is pale green over white LEDs)
      float frame = band * (1.0 - smoothstep(0.03 - aa, 0.03 + aa, abs(dmin - 0.16))) * (1.0 - gzFar);
      // by day: sea-green glass, darker toward its edges (the channel's shadow), the LED bar a pale mint line down
      // the middle where it shows through -- the strips read as a lattice across the paving, not a faint tint
      float core = 1.0 - smoothstep(0.035 - aa, 0.035 + aa, dmin);
      vec3 glassC = mix(vec3(0.05, 0.27, 0.21), vec3(0.12, 0.44, 0.35), 1.0 - smoothstep(0.04, 0.14, dmin));
      glassC = mix(glassC, vec3(0.66, 0.90, 0.80), core * (1.0 - gzFar));
      diffuseColor.rgb = mix(diffuseColor.rgb, glassC, strip);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.70, 0.71, 0.72), frame);
      // frosted (sandblasted walking glass): a mirror finish only showed the sky, washing the green out
      gzR = mix(gzR, 0.3, strip);
      gzR = mix(gzR, 0.3, frame);
      gzMapN.xy *= 1.0 - max(strip, frame);
      // which family the strip is in: the colour travels along it
      float along = dmin == d1 ? s2 : dmin == d2 ? s1 : bp.y;
      vec3 led = 0.5 + 0.5 * cos(6.2832 * (vec3(0.0, 0.33, 0.67) + along * 0.012 - uTime * 0.08));
      gzEmit += led * strip * uNight * 2.4;
      // --- the eye
      vec2 eo = (bp - vec2(-5.5, -21.0)) / vec2(30.5, 19.8);
      float er = length(eo);
      if (er < 1.02) {
        float rw = fwidth(er) * 1.5;
        float rim = smoothstep(0.86 - rw, 0.86, er) * (1.0 - smoothstep(1.0 - rw, 1.0, er));
        float rings = step(0.5, fract(er * 7.0)) * step(er, 0.86);
        float almond = abs(abs(eo.y) - 0.42 * (1.0 - eo.x * eo.x));
        float lid = (1.0 - smoothstep(0.012, 0.012 + rw, almond)) * step(abs(eo.x), 0.98);
        float pupil = 1.0 - smoothstep(0.16 - rw, 0.16, length(eo * vec2(30.5 / 19.8, 1.0)));
        float brass = (1.0 - smoothstep(0.012, 0.012 + rw, abs(length(eo * vec2(30.5 / 19.8, 1.0)) - 0.17)));
        vec3 gold = vec3(0.50, 0.37, 0.22), grey = vec3(0.47, 0.47, 0.46);
        vec3 base = diffuseColor.rgb;
        vec3 field = mix(base * 0.95, base * vec3(0.92, 0.88, 0.82), rings * 0.6);
        field = mix(field, gold * (0.9 + 0.2 * gzFbm(bp * 0.3)), rim);
        field = mix(field, gold * 0.8, lid);
        field = mix(field, grey * 0.35, pupil);
        field = mix(field, vec3(0.62, 0.48, 0.24), brass);
        diffuseColor.rgb = mix(base, field, step(er, 1.0));
        gzR = mix(gzR, 0.35, brass + rim * 0.3);
        gzEmit += vec3(0.25, 0.85, 1.0) * uNight * 1.6 * (1.0 - smoothstep(0.004, 0.004 + rw, abs(er - 0.995)));
      }
      ${wet(0.6)}`;

/** The court floor of 花城汇 (south court, and the north court of phase 3): concentric bands of beige and grey stone
 * round the middle of the court. */
const COURT = (k: Kit, cx = -6.25, cy = 66.0, rmax = 21.0) => /* glsl */`
      vec2 bp = vec2(wp.x, -wp.y);
      ${kitSample(k, 'bp * 0.75', 1.0)}
      float r = length(bp - vec2(${fx(cx)}, ${fx(cy)}));
      float rw = fwidth(r) * 1.5;
      float ring = step(0.5, fract(r / 3.0));
      float line = 1.0 - smoothstep(0.03, 0.03 + rw, abs(fract(r / 1.5 + 0.5) - 0.5) * 1.5);
      vec3 beige = vec3(0.70, 0.62, 0.50), grey = vec3(0.50, 0.50, 0.49);
      vec3 base = mix(beige, grey, ring) * step(r, ${fx(rmax)}) + vec3(0.62, 0.58, 0.52) * step(${fx(rmax)}, r);
      diffuseColor.rgb = base * kA * (0.92 + 0.12 * gzFbm(bp * 0.4)) * mix(1.0, kO.r, 0.8);
      diffuseColor.rgb *= 1.0 - 0.35 * line * step(r, ${fx(rmax)});
      // polished: the shopfronts show in it
      gzR = kO.g * 0.55;
      ${wet(0.7)}`;

/**
 * 花城汇 B1 (gz_mall; Commons "2024 in Mall of the World"): the corridor floor -- 0.8 m tiles of pale polished
 * porcelain on the corridor's grid, a band of dark granite 0.9 m wide along both shop fronts, a dark inlay across
 * every 12 m -- indoors, so no rain. bp = Blender (x, y); the corridor's centre line is x = -31.5.
 */
const MALL_FLOOR = /* glsl */`
      vec2 bp = vec2(wp.x, -wp.y);
      float ax = abs(bp.x + 31.5);
      vec2 tq = (bp - vec2(-31.5 + 0.4, 0.0)) / 0.8;
      vec2 tc = floor(tq), tf = fract(tq);
      float gw = max(fwidth(tq.x), fwidth(tq.y));
      float joint = 1.0 - smoothstep(0.0, gw * 1.5 + 0.004, min(min(tf.x, 1.0 - tf.x), min(tf.y, 1.0 - tf.y)));
      vec3 th = gzHash33(vec3(tc, 8.1));
      vec3 tile = vec3(0.86, 0.83, 0.77) * (0.95 + 0.07 * th.x) * (0.97 + 0.05 * gzFbm(bp * 0.7));
      // the dark granite borders along the shopfronts and the inlay bands across
      float border = step(3.9, ax) * step(bp.y, 148.5) * step(75.5, bp.y);
      float inlay = 1.0 - smoothstep(0.15, 0.15 + gw * 0.8, abs(fract((bp.y - 76.0) / 12.0 + 0.5) - 0.5) * 12.0);
      float dark = max(border, inlay * step(ax, 4.8));
      vec3 granite = vec3(0.17, 0.17, 0.18) * (0.85 + 0.3 * gzSpeck(bp, 70.0, 3.3));
      diffuseColor.rgb = mix(tile, granite, dark);
      diffuseColor.rgb *= 1.0 - 0.35 * joint * (1.0 - dark);
      gzR = mix(0.1 + 0.05 * th.y, 0.16, dark) + joint * 0.3;
      gzH = -joint * 0.0015;`;

/**
 * 花城汇 B1's ceiling (seen from below, 4.6 m up): white strip-aluminium grille running across the corridor (0.2 m
 * pitch, the void above dark between the strips), a timber-grain grille band along each side, two rows of
 * downlights in the white field and a lit cove along the inside of each timber band. Lit day and night.
 */
const MALL_CEILING = /* glsl */`
      vec2 bp = vec2(wp.x, -wp.y);
      float ax = abs(bp.x + 31.5);
      float gw = max(fwidth(bp.x), fwidth(bp.y));
      float fade = clamp(1.5 - gw * 30.0, 0.0, 1.0);
      // strips across (along x), every 0.2 m along y
      float sy = abs(fract(bp.y / 0.2) - 0.5) * 0.2;
      float gap = (1.0 - smoothstep(0.035, 0.035 + gw, sy)) * fade;
      vec3 white = vec3(0.93, 0.93, 0.91);
      vec3 col = mix(white, vec3(0.12, 0.12, 0.13), gap * 0.85);
      // timber bands: slats along the corridor every 0.15 m
      float wood = step(2.6, ax) * step(ax, 4.3);
      float sx = abs(fract(bp.x / 0.15) - 0.5) * 0.15;
      float wgap = (1.0 - smoothstep(0.022, 0.022 + gw, sx)) * fade;
      vec3 timber = vec3(0.52, 0.34, 0.19) * (0.85 + 0.25 * gzFbm(vec2(bp.x * 40.0, bp.y * 1.5))) * (0.92 + 0.12 * gzHash3(vec3(floor(bp.x / 0.15), 2.0, 7.0)));
      col = mix(col, mix(timber, vec3(0.08, 0.06, 0.05), wgap * 0.9), wood);
      diffuseColor.rgb = col;
      gzR = mix(0.45, 0.6, wood);
      // downlights: two rows in the white field, every 3 m; the coves on the timber bands' inner edges
      vec2 dq = vec2(ax - 1.6, fract(bp.y / 3.0 + 0.5) * 3.0 - 1.5);
      float dl = length(dq);
      float disc = 1.0 - smoothstep(0.08, 0.08 + gw * 1.5, dl);
      float halo = (1.0 - smoothstep(0.08, 0.5, dl)) * 0.12;
      float cove = (1.0 - smoothstep(0.03, 0.03 + gw * 1.5, abs(ax - 2.55)));
      gzEmit += vec3(1.0, 0.93, 0.82) * (disc * 6.0 + halo) * step(ax, 2.5) + vec3(1.0, 0.95, 0.88) * cove * 2.2;
      gzH = -gap * 0.002;`;

/** The baked-kit versions: the photographic detail comes from the kit, the procedural wear stays on top. */
function kitColor(kind: SurfaceKind, k: Kit, common: string): string | null {
  switch (kind) {
    case 'asphalt':
    case 'asphalt_world': {
      const rp = kind === 'asphalt' ? 'vGzUv' : 'wp';
      return common + /* glsl */`
      vec2 rp = ${rp};
      ${kitSample(k, 'rp', 1.2)}
      float mott = gzFbm(wp * 0.33);
      // the aggregate, softened a little with distance (a road across the frame should not sparkle)
      diffuseColor.rgb *= mix(vec3(1.0), kA, 0.8 - 0.3 * gzFar) * (0.82 + 0.3 * mott) * mix(1.0, kO.r, 0.8);
      vec2 pc = floor(rp / vec2(7.0, 3.5)), pf = fract(rp / vec2(7.0, 3.5));
      vec3 ph = gzHash33(vec3(pc, 7.7));
      float pw = fwidth(rp.x / 7.0) * 1.5;
      float patchM = step(ph.x, 0.13) * smoothstep(0.08 + 0.3 * ph.y, 0.08 + 0.3 * ph.y + pw, pf.x) * smoothstep(0.62 + 0.3 * ph.y + pw, 0.62 + 0.3 * ph.y, pf.x)
                   * smoothstep(0.12, 0.12 + pw * 2.0, pf.y) * smoothstep(0.88 + pw * 2.0, 0.88, pf.y);
      float tone = mix(1.0, 0.7 + 0.1 * ph.z, patchM);
      ${kind === 'asphalt' ? `
      float lv = fract(rp.y / 3.5);
      float trk = smoothstep(0.15, 0.03, abs(lv - 0.26)) + smoothstep(0.15, 0.03, abs(lv - 0.74));
      float oil = smoothstep(0.09, 0.0, abs(lv - 0.5)) * smoothstep(0.5, 0.75, gzFbm(rp * vec2(0.25, 2.2) + 11.0));
      tone *= (1.0 - 0.1 * trk) * (1.0 - 0.3 * oil);` : 'float trk = 0.0; float oil = 0.0;'}
      float cn = abs(gzNoise(wp * 0.7) - 0.5) + abs(gzNoise(wp * 1.9 + 4.0) - 0.5) * 0.35;
      float crack = gzLine(cn, 0.012, fwidth(cn)) * smoothstep(0.55, 0.7, gzFbm(wp * 0.11 + 2.0)) * (1.0 - patchM);
      tone *= 1.0 - 0.45 * crack;
      diffuseColor.rgb *= tone;
      // a patch is fresh, smoother binder: the aggregate shows less
      gzMapN.xy *= 1.0 - 0.6 * patchM;
      gzR = kO.g - 0.18 * trk - 0.06 * patchM - 0.3 * oil;
      gzH = -crack * 0.003;
      ${wet(0.5)}`;
    }
    case 'slab':
    case 'brick':
      return common + /* glsl */`
      ${kitSample(k, kind === 'slab' ? 'wp' : 'vGzUv', 1.0)}
      diffuseColor.rgb *= kA * (0.86 + 0.26 * gzFbm(wp * 0.21)) * mix(1.0, kO.r, 0.85);
      // dirt settles in the joints and along the kerb side; a few stains
      diffuseColor.rgb *= 1.0 - 0.18 * smoothstep(0.62, 0.8, gzFbm(wp * 0.6 + 3.3));
      gzR = kO.g;
      gzH = 0.0;
      ${wet(kind === 'slab' ? 0.6 : 0.55)}`;
    case 'plaza':
      return common + PLAZA(k);
    case 'court':
      return common + COURT(k);
    case 'court_north':
      return common + COURT(k, -3.0, 234.0, 10.5);
    case 'grass':
      return common + /* glsl */`
      ${kitSample(k, 'wp', 1.0)}
      float n1 = gzFbm(wp * 0.12), n2 = gzFbm(wp * 1.1 + 5.0);
      diffuseColor.rgb *= kA * (0.8 + 0.35 * n2) * mix(1.0, kO.r, 0.45);   // the blades' AO is deep: keep a little
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.17, 0.15, 0.06), smoothstep(0.55, 0.78, n1) * 0.4);
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.8, 1.05, 0.7), smoothstep(0.6, 0.3, n1) * 0.4);
      gzR = 0.92;
      gzH = n2 * 0.02;
      ${wet(0.75)}
      gzR = max(gzR, 0.45);`;
    default:
      return null;
  }
}

export function surfaceColor(kind: SurfaceKind): string {
  const common = /* glsl */`
    vec2 wp = vGzWorld.xz;
    float gzFar = smoothstep(40.0, 160.0, length(vGzWorld - cameraPosition));
    gzR = roughness; gzH = 0.0; gzHasMap = 0.0; gzTuv = vec2(0.0); gzMapN = vec3(0.0, 0.0, 1.0); gzEmit = vec3(0.0);`;
  const k = surfaceKit(kind);
  const baked = k ? kitColor(kind, k, common) : null;
  if (baked) return baked;
  switch (kind) {
    case 'plaza':
    case 'court':
    case 'court_north':
      return surfaceColor('slab');                // no kit loaded: plain slabs
    case 'mall_floor':
      return common + MALL_FLOOR;
    case 'mall_ceiling':
      return common + MALL_CEILING;
    case 'asphalt':
    case 'asphalt_world': {
      const rp = kind === 'asphalt' ? 'vGzUv' : 'wp';
      return common + /* glsl */`
      vec2 rp = ${rp};
      float spk = gzSpeck(wp, 55.0, 3.1);
      float spk2 = gzSpeck(wp, 13.0, 5.7);
      float mott = gzFbm(wp * 0.33);
      float tone = 0.8 + 0.34 * mott + (0.3 * (spk - 0.5) + 0.16 * (spk2 - 0.5)) * (1.0 - gzFar);
      // repair patches: one cell in seven, a darker, smoother rectangle
      vec2 pc = floor(rp / vec2(7.0, 3.5)), pf = fract(rp / vec2(7.0, 3.5));
      vec3 ph = gzHash33(vec3(pc, 7.7));
      float pw = fwidth(rp.x / 7.0) * 1.5;
      float patchM = step(ph.x, 0.13) * smoothstep(0.08 + 0.3 * ph.y, 0.08 + 0.3 * ph.y + pw, pf.x) * smoothstep(0.62 + 0.3 * ph.y + pw, 0.62 + 0.3 * ph.y, pf.x)
                   * smoothstep(0.12, 0.12 + pw * 2.0, pf.y) * smoothstep(0.88 + pw * 2.0, 0.88, pf.y);
      tone *= mix(1.0, 0.7 + 0.1 * ph.z, patchM);
      ${kind === 'asphalt' ? `
      // wheel tracks polished darker, oil drips down the lane centres
      float lv = fract(rp.y / 3.5);
      float trk = smoothstep(0.15, 0.03, abs(lv - 0.26)) + smoothstep(0.15, 0.03, abs(lv - 0.74));
      float oil = smoothstep(0.09, 0.0, abs(lv - 0.5)) * smoothstep(0.5, 0.75, gzFbm(rp * vec2(0.25, 2.2) + 11.0));
      tone *= (1.0 - 0.1 * trk) * (1.0 - 0.3 * oil);` : 'float trk = 0.0; float oil = 0.0;'}
      // sealed cracks: thin dark lines along a ridged noise, only in the worn parts
      float cn = abs(gzNoise(wp * 0.7) - 0.5) + abs(gzNoise(wp * 1.9 + 4.0) - 0.5) * 0.35;
      float crack = gzLine(cn, 0.012, fwidth(cn)) * smoothstep(0.55, 0.7, gzFbm(wp * 0.11 + 2.0)) * (1.0 - patchM);
      tone *= 1.0 - 0.45 * crack;
      diffuseColor.rgb *= tone;
      gzR = 0.92 - 0.2 * trk - 0.06 * patchM - 0.3 * oil;
      gzH = ((spk - 0.5) * 0.0025 + (spk2 - 0.5) * 0.003) * (1.0 - gzFar) - crack * 0.003;
      ${wet(0.5)}`;
    }
    case 'slab':
    case 'brick': {
      const [tx, ty, uvx] = kind === 'slab' ? [0.6, 0.3, 'wp'] : [0.2, 0.1, 'vGzUv'];
      return common + /* glsl */`
      vec2 tp = ${uvx};
      vec2 ts = vec2(${tx.toFixed(2)}, ${ty.toFixed(2)});
      float row = floor(tp.y / ts.y);
      vec2 q = vec2(tp.x / ts.x + 0.5 * mod(row, 2.0), tp.y / ts.y);
      vec2 cell = floor(q), fr = fract(q);
      vec2 e = min(fr, 1.0 - fr) * ts;
      float edge = min(e.x, e.y);
      float gw = max(fwidth(tp.x), fwidth(tp.y));
      float grout = gzLine(edge, 0.003, gw) * clamp(1.3 - gw * ${(kind === 'slab' ? 25 : 60).toFixed(1)}, 0.0, 1.0);
      vec3 th = gzHash33(vec3(cell, 4.2));
      float tone = ${kind === 'slab' ? '0.86 + 0.26 * th.x' : '0.78 + 0.4 * th.x'};
      tone *= 0.84 + 0.3 * gzFbm(wp * 0.21);
      tone *= 0.94 + 0.12 * (gzSpeck(wp, 90.0, 9.1) - 0.5) * (1.0 - gzFar) + 0.06;
      diffuseColor.rgb *= tone;
      ${kind === 'brick' ? 'diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.1, 0.95, 0.9), th.y);' : ''}
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.42, grout);
      gzR = 0.8 + 0.12 * th.y + grout * 0.1;
      gzH = (-grout * 0.004 + (th.z - 0.5) * 0.0012 * smoothstep(0.0, 0.02, edge)) * (1.0 - gzFar);
      ${wet(kind === 'slab' ? 0.6 : 0.55)}`;
    }
    case 'granite':
      return common + /* glsl */`
      vec3 gq = vGzWorld * 160.0;
      float gw = fwidth(gq.x) + fwidth(gq.z);
      float g1 = mix(0.5, gzHash3(floor(gq)), clamp(1.4 - gw, 0.0, 1.0));
      float g2 = gzSpeck(wp + vGzWorld.y, 40.0, 2.3);
      diffuseColor.rgb *= 0.86 + 0.3 * (g1 - 0.5) + 0.14 * (g2 - 0.5) + 0.12 * gzFbm(wp * 0.5);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05), step(0.93, g1) * 0.6 * (1.0 - gzFar));
      gzR = 0.62 + 0.2 * g2;
      gzH = (g1 - 0.5) * 0.0008;
      ${wet(0.62)}`;
    case 'grass':
      return common + /* glsl */`
      float n1 = gzFbm(wp * 0.12), n2 = gzFbm(wp * 1.1 + 5.0);
      float bl = gzSpeck(wp, 70.0, 6.6);
      diffuseColor.rgb *= 0.72 + 0.5 * n2 + 0.3 * (bl - 0.5) * (1.0 - gzFar);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.17, 0.15, 0.06), smoothstep(0.55, 0.78, n1) * 0.45);
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.8, 1.05, 0.7), smoothstep(0.6, 0.3, n1) * 0.4);
      gzR = 0.96;
      gzH = (bl - 0.5) * 0.006 * (1.0 - gzFar) + n2 * 0.02;
      ${wet(0.75)}
      gzR = max(gzR, 0.45);`;
    case 'concrete':
      return common + /* glsl */`
      float jx = abs(fract(vGzUv.x / 6.0 + 0.5) - 0.5) * 6.0;
      float joint = gzLine(jx, 0.008, fwidth(vGzUv.x));
      float st = gzFbm(wp * 0.4 + 1.3);
      diffuseColor.rgb *= (0.85 + 0.3 * st) * (1.0 - 0.5 * joint) * (0.95 + 0.1 * (gzSpeck(wp, 40.0, 1.1) - 0.5));
      gzR = 0.85; gzH = -joint * 0.004;
      ${wet(0.6)}`;
    case 'marking':
      return common + /* glsl */`
      float wear = smoothstep(0.45, 0.75, gzFbm(wp * 1.6 + 7.0) * 0.7 + gzSpeck(wp, 30.0, 4.4) * 0.3 * (1.0 - gzFar));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.06, 0.062, 0.065), wear * 0.75);
      gzR = mix(0.55, 0.9, wear);
      gzH = (1.0 - wear) * 0.0015;
      ${wet(0.8)}`;
  }
}

export const SURFACE_ROUGH = /* glsl */`
  roughnessFactor = clamp(gzR, 0.02, 1.0);`;

/** Derivative bump from gzH (three's perturbNormalArb, inlined: bump maps are not enabled on these materials). */
export const SURFACE_NORMAL = /* glsl */`
  if (gzHasMap > 0.5) normal = gzPerturb(normal, -vViewPosition, gzTuv, gzMapN);
  {
    vec3 sp = -vViewPosition;
    vec3 dpdx = dFdx(sp), dpdy = dFdy(sp);
    float hx = dFdx(gzH), hy = dFdy(gzH);
    vec3 r1 = cross(dpdy, normal), r2 = cross(normal, dpdx);
    float det = dot(dpdx, r1);
    vec3 grad = sign(det) * (hx * r1 + hy * r2);
    normal = normalize(abs(det) * normal - grad);
  }`;
