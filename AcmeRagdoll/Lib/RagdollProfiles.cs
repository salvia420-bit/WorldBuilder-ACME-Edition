using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.Json;
using AcmeRagdoll.Sim;
using Microsoft.Extensions.Logging;

namespace AcmeRagdoll.Lib {
    /// <summary>
    /// One body's Tier-0 SEMANTIC data, as parsed from its profile: what kind of creature the
    /// skeleton is, and what each part is FOR. Immutable after <see cref="RagdollProfiles.Load"/>
    /// publishes it, which is what makes it safe to hand to the native detour thread.
    ///
    /// C4's idle micro-motion is the only consumer: the archetype picks the oscillation shape, the
    /// roles weight it per part, and <see cref="Ground"/> pins the parts that stand on the floor.
    /// </summary>
    internal sealed class BodyRoles {
        /// <summary>The body-level archetype, or <see cref="BodyArchetype.Unknown"/> when the profile
        /// named none (or named one we do not know).</summary>
        public readonly BodyArchetype Archetype;

        /// <summary>Per-part <see cref="PartRole"/> as bytes, dense and indexed by part index, with 0
        /// (<see cref="PartRole.Unknown"/>) in the slots the profile did not name. Null when the body
        /// has an archetype but no per-part tags. NEVER MUTATED after load.</summary>
        public readonly byte[]? Roles;

        /// <summary>Per-part "this part rests on the floor" flags, same indexing as
        /// <see cref="Roles"/> and null in the same case. NEVER MUTATED after load.</summary>
        public readonly bool[]? Ground;

        public BodyRoles(BodyArchetype archetype, byte[]? roles, bool[]? ground) {
            Archetype = archetype;
            Roles = roles;
            Ground = ground;
        }
    }

    /// <summary>
    /// The per-body ragdoll profile table: Setup DataID -&gt; <see cref="RagdollParams"/>, loaded once
    /// from <c>ragdoll_profiles.json</c> sitting next to the plugin DLL.
    ///
    /// FILE FORMAT (extra fields at every level are ignored, so the profile generator's authoring
    /// metadata - legA/legC/notes/names - can stay in the same file):
    /// <code>
    /// { "profiles": {
    ///     "0x02000E08": { "params": { "impulse": 2.6, "toppleGain": 1.2, "fallFrames": 105,
    ///                                 "dirBiasDeg": 175.0, "dirBiasStrength": 0.4 },
    ///                     "parts": [ { "i": 0, "w": 0.15 }, { "i": 7, "w": 0.9 } ] }
    /// } }
    /// </code>
    /// Any parameter left out keeps its shipped default, so a profile lists only what it moves.
    ///
    /// THE "parts" ARRAY is the LIVE-MOTION seam and is entirely optional. It is the landing site for
    /// the Tier-0 per-part role tags, and it now carries three things:
    /// <code>
    ///   "archetype": "biped|quadruped|arthropod|avian|serpent|floater|blob|prop|mixed",
    ///   "parts": [ { "i": 0, "w": 0.15, "role": "core", "ground": false }, ... ]
    /// </code>
    ///   * <c>w</c> - a 0..1 LOOSENESS weight (0 = core, moves with the body; 1 = extremity, whips),
    ///     indexed by the body's part index <c>i</c>. This is what C2's spring layer reads
    ///     (<see cref="PartWeights"/>); a body without it falls back to
    ///     <see cref="AcmeRagdoll.Services.LiveMotionRegistry"/>'s structural heuristic.
    ///   * <c>role</c> / <c>ground</c> and the body-level <c>archetype</c> - the SEMANTIC half, read by
    ///     C4's idle micro-motion (<see cref="RolesFor"/> -&gt; <see cref="AcmeRagdoll.Sim.IdleMotion"/>):
    ///     the archetype picks the oscillation shape (breathe / bob+sway / pulse / nothing), the role
    ///     picks how much of it each part carries, and <c>ground</c> pins the parts that stand on the
    ///     floor. Death ragdolls read none of it.
    /// The two halves are parsed independently, so a body with roles but no weights (or the reverse)
    /// degrades on that half alone.
    ///
    /// THREADING / THE 0x80131509 RULE.  <see cref="Load"/> runs ONCE on the managed plugin thread
    /// (AcmeRagdollPlugin.Initialize), where file IO, JSON and assembly loading are all legal. What
    /// runs later on the native detour thread is only <see cref="For"/>: a lookup in a plain
    /// <see cref="Dictionary{TKey,TValue}"/> of uint -&gt; sealed class, allocating nothing and
    /// touching no type that is not already loaded (the plugin's warmup additionally calls For()
    /// once at init so the generic instantiation is JITed there, not in the detour).
    /// </summary>
    internal static class RagdollProfiles {
        /// <summary>Profile file name, resolved next to the plugin DLL.</summary>
        public const string FileName = "ragdoll_profiles.json";

        /// <summary>Sanity bound on a profile's fallFrames (30 fps): 1 frame .. 2 minutes. A corrupt
        /// or absurd value would otherwise pin the hot UpdateParts detour armed for hours.</summary>
        private const int FallFramesMin = 1;
        private const int FallFramesMax = 3600;

        /// <summary>Sanity bound on a "parts" array length: no AC setup has anywhere near this many
        /// parts, and an absurd index must not make us allocate a huge array at load time.</summary>
        private const int MaxPartWeights = 1024;

        /// <summary>Sentinel stored for a part index the profile did not mention: "no role weight,
        /// use the structural heuristic". Negative so it can never be mistaken for a 0..1 weight.</summary>
        public const float NoWeight = -1f;

        private static Dictionary<uint, RagdollParams> _map = new Dictionary<uint, RagdollParams>();
        private static Dictionary<uint, float[]> _partWeights = new Dictionary<uint, float[]>();
        private static Dictionary<uint, BodyRoles> _roles = new Dictionary<uint, BodyRoles>();

        /// <summary>How many bodies have a profile (0 when the file is missing or unreadable).</summary>
        public static int Count => _map.Count;

        /// <summary>How many bodies carry a per-part looseness array (the Tier-0 role seam). 0 until
        /// the Phase-B role data is merged into the profile file.</summary>
        public static int PartWeightCount => _partWeights.Count;

        /// <summary>How many bodies carry semantic role data (archetype and/or per-part roles) - the
        /// C4 idle-motion seam.</summary>
        public static int RoleCount => _roles.Count;

        /// <summary>This body's parameters, or <see cref="RagdollParams.Default"/> when it has no
        /// profile. Detour-safe: dictionary lookup only, no allocation, no lazy type load.</summary>
        public static RagdollParams For(uint setupDid) =>
            _map.TryGetValue(setupDid, out RagdollParams? p) && p != null ? p : RagdollParams.Default;

        /// <summary>
        /// This body's per-part LOOSENESS weights (0 = core/stiff, 1 = extremity/loose), or null when
        /// the profile has no "parts" array. Entries the profile did not mention are
        /// <see cref="NoWeight"/>, meaning "use the structural heuristic for this part" - so a partial
        /// role tagging is legal and only overrides the parts it names.
        ///
        /// Detour-safe for the same reason as <see cref="For"/>: a lookup in a read-only dictionary
        /// built at plugin init, returning an array that is never mutated afterwards.
        /// </summary>
        public static float[]? PartWeights(uint setupDid) =>
            _partWeights.TryGetValue(setupDid, out float[]? w) ? w : null;

        /// <summary>
        /// This body's SEMANTIC role data - archetype plus the per-part role/ground tags - or null
        /// when the profile carries none. C4's idle micro-motion is the only reader.
        ///
        /// Detour-safe exactly like <see cref="For"/> and <see cref="PartWeights"/>: one lookup in a
        /// read-only dictionary built at plugin init, returning an immutable record whose arrays are
        /// never mutated afterwards.
        /// </summary>
        public static BodyRoles? RolesFor(uint setupDid) =>
            _roles.TryGetValue(setupDid, out BodyRoles? r) ? r : null;

        /// <summary>
        /// Parse the profile file that sits beside the plugin DLL. Call from the managed plugin
        /// thread only. A missing or corrupt file is NOT an error: the table stays empty and every
        /// body falls with the shipped defaults; exactly one line is logged either way.
        /// </summary>
        public static void Load(ILogger log, string? pluginDir = null) {
            // Prefer the plugin directory the host handed us (Manifest.ManifestFile's dir). A Chorizite
            // plugin loads into a collectible ALC where Assembly.Location is EMPTY, so ResolvePath's
            // Assembly.Location fallback lands on the host base dir and never finds the file - which is
            // why "0 profiles loaded" happened live. The passed-in dir is the fix; ResolvePath stays as
            // a last resort (e.g. the offline harness that calls Load(log) with no dir).
            string path = !string.IsNullOrEmpty(pluginDir)
                ? Path.Combine(pluginDir, FileName)
                : ResolvePath();
            Dictionary<uint, RagdollParams> map = new Dictionary<uint, RagdollParams>();
            Dictionary<uint, float[]> weights = new Dictionary<uint, float[]>();
            Dictionary<uint, BodyRoles> roles = new Dictionary<uint, BodyRoles>();
            try {
                if (!File.Exists(path)) {
                    _map = map;
                    _partWeights = weights;
                    _roles = roles;
                    log.LogInformation("ragdoll: 0 profiles loaded (no {File} beside the plugin; " +
                                       "every body uses default params) path={Path}", FileName, path);
                    return;
                }

                int skipped = 0;
                using (JsonDocument doc = JsonDocument.Parse(File.ReadAllBytes(path))) {
                    if (doc.RootElement.ValueKind == JsonValueKind.Object &&
                        doc.RootElement.TryGetProperty("profiles", out JsonElement profiles) &&
                        profiles.ValueKind == JsonValueKind.Object) {
                        foreach (JsonProperty entry in profiles.EnumerateObject()) {
                            if (!TryParseDid(entry.Name, out uint did)) { skipped++; continue; }
                            if (entry.Value.ValueKind != JsonValueKind.Object) { skipped++; continue; }
                            if (!entry.Value.TryGetProperty("params", out JsonElement prm) ||
                                prm.ValueKind != JsonValueKind.Object) { skipped++; continue; }
                            map[did] = ParseParams(prm);
                            // Optional live-motion role seam; a malformed/absent array simply leaves the
                            // body on the structural heuristic and never costs it its death params.
                            entry.Value.TryGetProperty("parts", out JsonElement parts);
                            if (parts.ValueKind == JsonValueKind.Array) {
                                float[]? w = ParsePartWeights(parts);
                                if (w != null) weights[did] = w;
                            }
                            // C4 seam: the semantic half of the same "parts" array, plus the body-level
                            // archetype. Parsed independently of the weights so one being malformed
                            // never costs the body the other.
                            BodyRoles? br = ParseRoles(entry.Value, parts);
                            if (br != null) roles[did] = br;
                        }
                    }
                    else skipped++;
                }

                _map = map;
                _partWeights = weights;
                _roles = roles;
                log.LogInformation("ragdoll: {N} profiles loaded from {Path} (skipped={Skipped}, partWeights={PW}, roles={R})",
                                   map.Count, path, skipped, weights.Count, roles.Count);
            }
            catch (Exception ex) {
                _map = new Dictionary<uint, RagdollParams>();
                _partWeights = new Dictionary<uint, float[]>();
                _roles = new Dictionary<uint, BodyRoles>();
                log.LogWarning(ex, "ragdoll: 0 profiles loaded ({File} unreadable/corrupt at {Path}); " +
                                   "every body uses default params", FileName, path);
            }
        }

        /// <summary>
        /// Parse one body's optional <c>"parts": [{"i":0,"w":0.4}, ...]</c> looseness array into a
        /// dense float[] indexed by part index, with <see cref="NoWeight"/> in every slot the profile
        /// did not name. Returns null when the element is not a usable array or names no valid entry,
        /// so a typo degrades to the heuristic rather than to a body with all-zero weights.
        /// </summary>
        private static float[]? ParsePartWeights(JsonElement arr) {
            if (arr.ValueKind != JsonValueKind.Array) return null;

            int maxIdx = -1;
            foreach (JsonElement el in arr.EnumerateArray()) {
                if (el.ValueKind != JsonValueKind.Object) continue;
                if (!el.TryGetProperty("i", out JsonElement iv) || iv.ValueKind != JsonValueKind.Number) continue;
                if (!iv.TryGetInt32(out int idx) || idx < 0 || idx >= MaxPartWeights) continue;
                if (idx > maxIdx) maxIdx = idx;
            }
            if (maxIdx < 0) return null;

            var w = new float[maxIdx + 1];
            for (int i = 0; i <= maxIdx; i++) w[i] = NoWeight;

            int named = 0;
            foreach (JsonElement el in arr.EnumerateArray()) {
                if (el.ValueKind != JsonValueKind.Object) continue;
                if (!el.TryGetProperty("i", out JsonElement iv) || iv.ValueKind != JsonValueKind.Number) continue;
                if (!iv.TryGetInt32(out int idx) || idx < 0 || idx > maxIdx) continue;
                if (!el.TryGetProperty("w", out JsonElement wv) || wv.ValueKind != JsonValueKind.Number) continue;
                if (!wv.TryGetSingle(out float f) || !IsFinite(f)) continue;
                if (f < 0f) f = 0f;
                if (f > 1f) f = 1f;
                w[idx] = f;
                named++;
            }
            return named > 0 ? w : null;
        }

        /// <summary>
        /// Parse the SEMANTIC half of a profile: the body-level <c>"archetype"</c> string and the
        /// per-part <c>"role"</c> / <c>"ground"</c> tags out of the same <c>"parts"</c> array the
        /// looseness weights come from. Returns null when the body carries neither a recognised
        /// archetype nor a single usable role/ground tag, so a body with no Tier-0 data simply has no
        /// entry (and C4 then treats it as <see cref="BodyArchetype.Unknown"/> - breathing off the
        /// structural heuristic - rather than as a body with empty roles).
        ///
        /// Every array is DENSE and indexed by part index, with <see cref="PartRole.Unknown"/> / false
        /// in the slots the profile did not name, mirroring <see cref="ParsePartWeights"/>.
        /// </summary>
        private static BodyRoles? ParseRoles(JsonElement body, JsonElement parts) {
            BodyArchetype arch = BodyArchetype.Unknown;
            if (body.TryGetProperty("archetype", out JsonElement av) && av.ValueKind == JsonValueKind.String)
                arch = IdleMotion.ParseArchetype(av.GetString());

            byte[]? roles = null;
            bool[]? ground = null;

            if (parts.ValueKind == JsonValueKind.Array) {
                int maxIdx = -1;
                foreach (JsonElement el in parts.EnumerateArray()) {
                    if (el.ValueKind != JsonValueKind.Object) continue;
                    if (!el.TryGetProperty("i", out JsonElement iv) || iv.ValueKind != JsonValueKind.Number) continue;
                    if (!iv.TryGetInt32(out int idx) || idx < 0 || idx >= MaxPartWeights) continue;
                    if (idx > maxIdx) maxIdx = idx;
                }

                if (maxIdx >= 0) {
                    var r = new byte[maxIdx + 1];      // 0 == PartRole.Unknown
                    var g = new bool[maxIdx + 1];
                    int named = 0;
                    foreach (JsonElement el in parts.EnumerateArray()) {
                        if (el.ValueKind != JsonValueKind.Object) continue;
                        if (!el.TryGetProperty("i", out JsonElement iv) || iv.ValueKind != JsonValueKind.Number) continue;
                        if (!iv.TryGetInt32(out int idx) || idx < 0 || idx > maxIdx) continue;
                        if (el.TryGetProperty("role", out JsonElement rv) && rv.ValueKind == JsonValueKind.String) {
                            PartRole role = IdleMotion.ParseRole(rv.GetString());
                            if (role != PartRole.Unknown) { r[idx] = (byte)role; named++; }
                        }
                        if (el.TryGetProperty("ground", out JsonElement gv) && gv.ValueKind == JsonValueKind.True) {
                            g[idx] = true; named++;
                        }
                    }
                    if (named > 0) { roles = r; ground = g; }
                }
            }

            if (arch == BodyArchetype.Unknown && roles == null) return null;
            return new BodyRoles(arch, roles, ground);
        }

        // ------------------------------------------------------------------ parsing

        /// <summary>Build one body's params, taking the shipped default for every key the profile
        /// does not mention. Unknown keys and non-numeric values are ignored.</summary>
        private static RagdollParams ParseParams(JsonElement o) {
            float impulse = RagdollParams.DefaultImpulse;
            float toppleGain = RagdollParams.DefaultToppleGain;
            float toppleRateCap = RagdollParams.DefaultToppleRateCap;
            float twist = RagdollParams.DefaultTwist;
            float dirJitter = RagdollParams.DefaultDirJitter;
            float linearFrac = RagdollParams.DefaultLinearFrac;
            float jitter = RagdollParams.DefaultJitter;
            float bounceMax = RagdollParams.DefaultBounceMax;
            float maxSpeed = RagdollParams.DefaultMaxSpeed;
            float maxUpSpeed = RagdollParams.DefaultMaxUpSpeed;
            float damping = RagdollParams.DefaultDamping;
            float floorFriction = RagdollParams.DefaultFloorFriction;
            float giveMin = RagdollParams.DefaultGiveMin;
            float giveSpan = RagdollParams.DefaultGiveSpan;
            float giveRamp = RagdollParams.DefaultGiveRamp;
            float coreBias = RagdollParams.DefaultCoreBias;
            int fallFrames = RagdollParams.DefaultFallFrames;
            float? dirBiasDeg = null;
            float dirBiasStrength = RagdollParams.DefaultDirBiasStrength;

            foreach (JsonProperty p in o.EnumerateObject()) {
                JsonElement v = p.Value;
                bool num = v.ValueKind == JsonValueKind.Number;
                string name = p.Name;
                bool Is(string n) => string.Equals(name, n, StringComparison.OrdinalIgnoreCase);

                if (Is("impulse")) { if (num) Read(v, ref impulse); }
                else if (Is("toppleGain")) { if (num) Read(v, ref toppleGain); }
                else if (Is("toppleRateCap")) { if (num) Read(v, ref toppleRateCap); }
                else if (Is("twist")) { if (num) Read(v, ref twist); }
                else if (Is("dirJitter")) { if (num) Read(v, ref dirJitter); }
                else if (Is("linearFrac")) { if (num) Read(v, ref linearFrac); }
                else if (Is("jitter")) { if (num) Read(v, ref jitter); }
                else if (Is("bounceMax")) { if (num) Read(v, ref bounceMax); }
                else if (Is("maxSpeed")) { if (num) Read(v, ref maxSpeed); }
                else if (Is("maxUpSpeed")) { if (num) Read(v, ref maxUpSpeed); }
                else if (Is("damping")) { if (num) Read(v, ref damping); }
                else if (Is("floorFriction")) { if (num) Read(v, ref floorFriction); }
                else if (Is("giveMin")) { if (num) Read(v, ref giveMin); }
                else if (Is("giveSpan")) { if (num) Read(v, ref giveSpan); }
                else if (Is("giveRamp")) { if (num) Read(v, ref giveRamp); }
                else if (Is("coreBias")) { if (num) Read(v, ref coreBias); }
                else if (Is("dirBiasStrength")) { if (num) Read(v, ref dirBiasStrength); }
                else if (Is("fallFrames")) {
                    if (num && v.TryGetInt32(out int ff)) {
                        if (ff < FallFramesMin) ff = FallFramesMin;
                        if (ff > FallFramesMax) ff = FallFramesMax;
                        fallFrames = ff;
                    }
                }
                else if (Is("dirBiasDeg")) {
                    // explicit null (or a nonsense number) means "no bias" - the shipped behaviour.
                    if (num && v.TryGetSingle(out float bd) && IsFinite(bd)) dirBiasDeg = bd;
                    else dirBiasDeg = null;
                }
            }

            return new RagdollParams(impulse, toppleGain, toppleRateCap, twist, dirJitter, linearFrac,
                                     jitter, bounceMax, maxSpeed, maxUpSpeed, damping, floorFriction,
                                     giveMin, giveSpan, giveRamp, coreBias, fallFrames,
                                     dirBiasDeg, dirBiasStrength);
        }

        private static void Read(JsonElement v, ref float target) {
            if (v.TryGetSingle(out float f) && IsFinite(f)) target = f;
        }

        private static bool IsFinite(float v) => !float.IsNaN(v) && !float.IsInfinity(v);

        /// <summary>Profile keys are hex Setup DataIDs ("0x02000E08"); a bare decimal is accepted too.</summary>
        private static bool TryParseDid(string key, out uint did) {
            did = 0;
            if (string.IsNullOrWhiteSpace(key)) return false;
            string s = key.Trim();
            if (s.Length > 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X'))
                return uint.TryParse(s.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out did);
            return uint.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out did);
        }

        /// <summary>The profile file lives beside the plugin DLL (the Chorizite plugin directory).</summary>
        private static string ResolvePath() {
            string dir;
            try {
                string loc = typeof(RagdollProfiles).Assembly.Location;
                dir = string.IsNullOrEmpty(loc)
                    ? AppContext.BaseDirectory
                    : (Path.GetDirectoryName(loc) ?? AppContext.BaseDirectory);
            }
            catch { dir = AppContext.BaseDirectory; }
            return Path.Combine(dir, FileName);
        }
    }
}
