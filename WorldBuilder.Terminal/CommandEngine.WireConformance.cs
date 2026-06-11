using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Chorizite.ACProtocol;
using Chorizite.ACProtocol.Messages;
using C2S = Chorizite.ACProtocol.Messages.C2S;
using S2C = Chorizite.ACProtocol.Messages.S2C;

namespace WorldBuilder.Terminal;

/// <summary>
/// Wave-1 diagnostic surface: AC wire-packet pack/unpack conformance, sourced
/// from the vendored <c>Chorizite.ACProtocol</c> generated message types.
/// See <c>docs/diagnostic-toolset-plan-2026-05-19.md</c> §6 Wave 1 and the
/// matching method doc at <c>docs/wire-conformance-method.md</c>.
///
/// The W1.A0 spike (2026-05-19) cleared the ProjectReference path — adding
/// <c>Chorizite.ACProtocol.csproj</c> as a ProjectReference to
/// WorldBuilder.Terminal pulls in only <c>Chorizite.ACProtocol.dll</c>
/// (≈393 KB) + <c>Medo.PcapRW.dll</c> (40 KB) + <c>System.CodeDom.dll</c>
/// (184 KB), a +1 MB delta. No RmlUi/Lua/Autofac/Silk surfaced. See
/// memory note <c>reference_chorizite_acprotocol_dep_graph_2026-05-19.md</c>.
///
/// Commands in this file:
///
///   - <c>chorizite-wire-pack-message</c> — JSON fields → wire bytes via
///     Chorizite's generated <c>Write(BinaryWriter)</c>. Returns hex +
///     length + sha256.
///   - <c>chorizite-wire-unpack-message</c> — wire bytes → JSON fields via
///     Chorizite's generated <c>Read(BinaryReader)</c>. Round-trips by
///     default (re-packs and reports byte-equality).
///   - <c>chorizite-wire-list-message-types</c> — enumerate every
///     ACProtocol message type the reflection layer can resolve, for use
///     when authoring fixtures (validates a typeName before fixture
///     authoring).
///
/// Header-mode contract (CRITICAL for matching Rust holtburger-protocol):
///
///   <c>headerMode = "payload"</c> (default) — emit only the subclass
///   payload bytes. For an Ordered_GameAction subclass that strips the
///   base header (sequence + actionType); for an Ordered_GameEvent subclass
///   that strips the base header (objectId + sequence + eventType); for a
///   top-level ACS2CMessage/ACC2SMessage that means the bare
///   <c>instance.Write</c> output with NO opcode prefix. This matches what
///   a wire trace shows after network framing is stripped.
///
///   <c>headerMode = "full"</c> — emit the full Chorizite-side bytes
///   exactly, adding the opcode + the base envelope.
///
/// Why this exists: Wave 1's whole job is to surface byte-level
/// divergences between Chorizite (the canonical pack/unpack oracle) and
/// our Rust <c>holtburger-protocol</c> crate. Surfacing means flagging,
/// not fudging — per [[feedback_ground_in_real_wire_data]] and the
/// plan's §6 "don't bypass; flag" instruction.
/// </summary>
public partial class CommandEngine {

    // ─────────────────────────────────────────────────────────────────
    //  Reflection layer — message type registry
    // ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Index of every concrete <see cref="ACMessage"/> subclass in the
    /// loaded Chorizite.ACProtocol assembly, keyed by the short typeName
    /// (e.g. <c>"Movement_Jump"</c>, <c>"Item_CreateObject"</c>) plus the
    /// fully-qualified name (e.g.
    /// <c>"Chorizite.ACProtocol.Messages.C2S.Actions.Movement_Jump"</c>).
    /// Lazily populated once per process.
    /// </summary>
    private static Dictionary<string, Type>? _wireMessageTypeIndex;
    private static readonly object _wireIndexLock = new();

    private static Dictionary<string, Type> GetMessageTypeIndex() {
        if (_wireMessageTypeIndex != null) return _wireMessageTypeIndex;
        lock (_wireIndexLock) {
            if (_wireMessageTypeIndex != null) return _wireMessageTypeIndex;
            var asm = typeof(ACMessage).Assembly;
            var d = new Dictionary<string, Type>(StringComparer.OrdinalIgnoreCase);
            foreach (var t in asm.GetTypes()) {
                if (t.IsAbstract || !typeof(ACMessage).IsAssignableFrom(t)) continue;
                if (!d.ContainsKey(t.Name)) d[t.Name] = t;
                d[t.FullName!] = t;
            }
            _wireMessageTypeIndex = d;
        }
        return _wireMessageTypeIndex;
    }

    private static Type ResolveMessageType(string typeName) {
        var index = GetMessageTypeIndex();
        if (index.TryGetValue(typeName, out var t)) return t;
        throw new ArgumentException(
            $"Unknown wire message type '{typeName}'. " +
            $"Use chorizite-wire-list-message-types to enumerate available types.");
    }

    // ─────────────────────────────────────────────────────────────────
    //  chorizite-wire-list-message-types
    // ─────────────────────────────────────────────────────────────────

    public sealed record WireTypeListEntry(
        string TypeName,
        string FullName,
        string Direction,         // "C2S" | "S2C" | "C2S-Action" | "S2C-Event" | "Other"
        uint? OpCode);            // null when the type has no static opcode (game actions/events nested)

    public sealed record WireTypeListResult(
        int Count,
        IReadOnlyList<WireTypeListEntry> Types);

    public WireTypeListResult ChoriziteWireListMessageTypes() {
        var entries = new List<WireTypeListEntry>();
        foreach (var (key, t) in GetMessageTypeIndex()) {
            if (key != t.Name) continue;             // skip FullName aliases
            if (t.IsAbstract) continue;
            string direction =
                t.Namespace == "Chorizite.ACProtocol.Messages.C2S.Actions" ? "C2S-Action"
                : t.Namespace == "Chorizite.ACProtocol.Messages.S2C.Events" ? "S2C-Event"
                : t.Namespace == "Chorizite.ACProtocol.Messages.C2S" ? "C2S"
                : t.Namespace == "Chorizite.ACProtocol.Messages.S2C" ? "S2C"
                : "Other";
            uint? opcode = null;
            try {
                var inst = Activator.CreateInstance(t);
                var prop = t.GetProperty(nameof(ACMessage.OpCode));
                if (prop != null && inst != null) {
                    var v = prop.GetValue(inst);
                    if (v is uint u) opcode = u;
                }
            } catch { /* abstract / no default ctor — leave opcode null */ }
            entries.Add(new WireTypeListEntry(t.Name, t.FullName!, direction, opcode));
        }
        entries.Sort((a, b) => string.Compare(a.TypeName, b.TypeName, StringComparison.Ordinal));
        return new WireTypeListResult(entries.Count, entries);
    }

    // ─────────────────────────────────────────────────────────────────
    //  chorizite-wire-pack-message
    // ─────────────────────────────────────────────────────────────────

    public sealed record WirePackResult(
        string MessageType,
        string FullName,
        string HeaderMode,
        string HexBytes,
        int ByteLen,
        string Sha256,
        uint? OpCode);

    /// <summary>
    /// Resolve <paramref name="typeName"/> via reflection, populate its
    /// public fields from <paramref name="fields"/>, then invoke
    /// <see cref="ACMessage.Write(BinaryWriter)"/>. Returns hex bytes +
    /// length + sha256.
    ///
    /// <paramref name="headerMode"/> controls which Chorizite header
    /// bytes are included; see this file's class-level remarks for the
    /// contract. Default <c>"payload"</c> drops the
    /// <c>Ordered_GameAction</c> wrapper for actions and mirrors what
    /// the Rust <c>holtburger-protocol::messages::game_action::GameActionMessage::pack</c>
    /// emits.
    /// </summary>
    public WirePackResult ChoriziteWirePackMessage(string typeName, JsonNode? fields, string? headerMode = null) {
        var type = ResolveMessageType(typeName);
        var instance = (ACMessage)Activator.CreateInstance(type)!;
        // Auto-populate ActionType / EventType from the subclass name. The Chorizite
        // generator leaves these fields default — but the on-wire format requires
        // them. By convention each subclass under Messages/C2S/Actions/ has a
        // matching member in GameActionType enum (likewise for Events/GameEventType).
        InferActionEventType(instance, type);
        if (fields != null) PopulateFromJson(instance, fields);
        // Lazy-init any null nested IACDataType fields the user didn't provide,
        // so Write()'s `field.Write(writer)` calls don't NullRef. Generated
        // subclasses do this in Read() but not in default-construction.
        InitializeNullNestedFields(instance);

        var mode = (headerMode ?? "payload").ToLowerInvariant();
        if (mode != "payload" && mode != "full") {
            throw new ArgumentException($"Invalid headerMode '{headerMode}'. Use 'payload' or 'full'.");
        }

        byte[] bytes;
        using (var ms = new MemoryStream())
        using (var bw = new BinaryWriter(ms, Encoding.UTF8, leaveOpen: true)) {
            // Reusable helper: after every leaf Write(), the underlying
            // MemoryStream may have a Position past Length (Chorizite's
            // `Seek(n, SeekOrigin.Current)` skip-without-write for 4-byte
            // align padding). Normalize: extend Length to Position so the
            // pad bytes materialize as zeros, matching the on-wire format
            // that acclient.exe / ACE produce.
            void NormalizeStream() {
                if (ms.Position > ms.Length) ms.SetLength(ms.Position);
            }
            if (mode == "full") {
                // Full Chorizite-side bytes: opcode + ...
                if (instance is C2S.Ordered_GameAction action) {
                    bw.Write((uint)action.OpCode);              // 0xF7B1 wrapper
                    bw.Write(action.OrderedSequence);
                    bw.Write((uint)action.ActionType);
                    // The subclass-specific payload follows. The subclass's
                    // Write() ALSO emits sequence + actionType through
                    // base.Write(), so we'd double-emit. Instead: skip base.
                    EmitPayloadOnlySubclass(instance, bw);
                } else if (instance is S2C.Ordered_GameEvent ev) {
                    bw.Write((uint)ev.OpCode);
                    bw.Write(ev.OrderedObjectId);
                    bw.Write(ev.OrderedSequence);
                    bw.Write((uint)ev.EventType);
                    EmitPayloadOnlySubclass(instance, bw);
                } else {
                    // Top-level (non-action/event) message. The subclass's Write()
                    // does NOT prepend the opcode — Chorizite's
                    // S2CMessageHandler.ProcessS2CMessage reads it BEFORE
                    // dispatch. So in "full" mode we prepend it here.
                    var opcodePropPre = type.GetProperty(nameof(ACMessage.OpCode));
                    if (opcodePropPre != null) {
                        var op = opcodePropPre.GetValue(instance);
                        if (op is uint opValue) bw.Write(opValue);
                    }
                    instance.Write(bw);
                    NormalizeStream();
                }
                NormalizeStream();
            } else {
                // "payload" mode — strip outer-message header for game actions/events
                // so this matches the Rust crate's payload-only pack.
                if (instance is C2S.Ordered_GameAction) {
                    EmitPayloadOnlySubclass(instance, bw);
                } else if (instance is S2C.Ordered_GameEvent) {
                    EmitPayloadOnlySubclass(instance, bw);
                } else {
                    instance.Write(bw);
                }
                NormalizeStream();
            }
            bw.Flush();
            NormalizeStream();
            bytes = ms.ToArray();
        }
        var sha = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var opcodeProp = type.GetProperty(nameof(ACMessage.OpCode))?.GetValue(instance);
        uint? opcode = opcodeProp is uint u ? u : null;
        return new WirePackResult(
            MessageType: type.Name,
            FullName: type.FullName!,
            HeaderMode: mode,
            HexBytes: Convert.ToHexString(bytes).ToLowerInvariant(),
            ByteLen: bytes.Length,
            Sha256: sha,
            OpCode: opcode);
    }

    /// <summary>
    /// Walk public instance fields (including inherited); for any nested
    /// reference type that's still null, instantiate it via default ctor.
    /// </summary>
    private static void InitializeNullNestedFields(object instance) {
        for (var t = instance.GetType(); t != null && t != typeof(object); t = t.BaseType) {
            foreach (var f in t.GetFields(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)) {
                if (f.FieldType.IsValueType || f.FieldType == typeof(string)) continue;
                if (f.FieldType.IsGenericType && f.FieldType.GetGenericTypeDefinition() == typeof(List<>)) {
                    // List<T> is auto-initialized at field-init via `= new()` on most types;
                    // but defensively allocate one if null.
                    if (f.GetValue(instance) == null) {
                        try { f.SetValue(instance, Activator.CreateInstance(f.FieldType)); } catch { }
                    }
                    continue;
                }
                var v = f.GetValue(instance);
                if (v == null) {
                    try {
                        var inst = Activator.CreateInstance(f.FieldType);
                        if (inst != null) {
                            f.SetValue(instance, inst);
                            InitializeNullNestedFields(inst);  // recurse
                        }
                    } catch { /* type has no default ctor — leave null */ }
                } else {
                    InitializeNullNestedFields(v);
                }
            }
        }
    }

    /// <summary>
    /// Auto-set the <c>ActionType</c> field on an <c>Ordered_GameAction</c>
    /// subclass (or <c>EventType</c> on <c>Ordered_GameEvent</c>) based on
    /// the subclass name. Each generated subclass under
    /// <c>Messages/C2S/Actions/</c> has a matching member in
    /// <see cref="Chorizite.ACProtocol.Enums.GameActionType"/>.
    /// </summary>
    private static void InferActionEventType(ACMessage instance, Type type) {
        if (instance is C2S.Ordered_GameAction action) {
            var t = typeof(Chorizite.ACProtocol.Enums.GameActionType);
            if (Enum.TryParse(t, type.Name, ignoreCase: false, out var val) && val != null) {
                action.ActionType = (Chorizite.ACProtocol.Enums.GameActionType)val;
            }
        } else if (instance is S2C.Ordered_GameEvent ev) {
            var t = typeof(Chorizite.ACProtocol.Enums.GameEventType);
            if (Enum.TryParse(t, type.Name, ignoreCase: false, out var val) && val != null) {
                ev.EventType = (Chorizite.ACProtocol.Enums.GameEventType)val;
            }
        }
    }

    /// <summary>
    /// Invoke the leaf-most class's <c>Write</c> on the instance, but
    /// short-circuit the base-class header writes (sequence + actionType
    /// / objectId + sequence + eventType). The trick: each generated
    /// subclass's <c>Write</c> begins with <c>base.Write(writer)</c>, so
    /// we need to write the subclass-specific fields without the base
    /// prefix.
    ///
    /// Approach: use a scratch <see cref="MemoryStream"/>, invoke the
    /// full <c>Write</c>, then strip the known-length prefix bytes
    /// (8 bytes for Ordered_GameAction header — sequence + actionType;
    /// 12 bytes for Ordered_GameEvent header — objectId + sequence + eventType).
    ///
    /// This is reflection-free but tightly coupled to Chorizite's
    /// generated code — if the upstream template changes, this needs to
    /// be revisited.
    /// </summary>
    private static void EmitPayloadOnlySubclass(ACMessage instance, BinaryWriter outWriter) {
        using var ms = new MemoryStream();
        using (var bw = new BinaryWriter(ms, Encoding.UTF8, leaveOpen: true)) {
            instance.Write(bw);
            bw.Flush();
            // Chorizite uses Seek-without-Write for align-pad — extend
            // length so those zero bytes show up in the on-wire bytes.
            if (ms.Position > ms.Length) ms.SetLength(ms.Position);
        }
        var all = ms.ToArray();
        int skip = instance switch {
            C2S.Ordered_GameAction => 8,    // sequence(u32) + actionType(u32)
            S2C.Ordered_GameEvent => 12,    // objectId(u32) + sequence(u32) + eventType(u32)
            _ => 0,
        };
        if (skip > all.Length) skip = all.Length;
        outWriter.Write(all, skip, all.Length - skip);
    }

    // ─────────────────────────────────────────────────────────────────
    //  chorizite-wire-unpack-message
    // ─────────────────────────────────────────────────────────────────

    public sealed record WireUnpackResult(
        string MessageType,
        string FullName,
        string HeaderMode,
        JsonNode Fields,
        bool Roundtrip,
        string? RoundtripDiff);

    /// <summary>
    /// Decode <paramref name="hexBytes"/> into a Chorizite message
    /// instance. If <paramref name="typeName"/> is provided it's a
    /// direct dispatch (skips opcode discovery); otherwise the first
    /// 4 bytes (uint32 LE) are read as opcode and dispatch goes through
    /// the same Chorizite static handler the live client uses.
    ///
    /// Round-trips by default: re-packs via
    /// <see cref="ChoriziteWirePackMessage"/> with the same
    /// <paramref name="headerMode"/> and compares bytes; reports the
    /// position of the first byte diff if any.
    /// </summary>
    public WireUnpackResult ChoriziteWireUnpackMessage(string hexBytes, string? typeName, string? headerMode = null) {
        var bytes = ParseHex(hexBytes);
        var mode = (headerMode ?? "payload").ToLowerInvariant();
        if (mode != "payload" && mode != "full") {
            throw new ArgumentException($"Invalid headerMode '{headerMode}'. Use 'payload' or 'full'.");
        }

        ACMessage instance;
        Type resolvedType;
        if (!string.IsNullOrWhiteSpace(typeName)) {
            resolvedType = ResolveMessageType(typeName);
            instance = (ACMessage)Activator.CreateInstance(resolvedType)!;
            using var ms = new MemoryStream(bytes);
            using var br = new BinaryReader(ms, Encoding.UTF8, leaveOpen: true);
            if (mode == "full") {
                if (instance is C2S.Ordered_GameAction action) {
                    // Skip outer opcode (we trust the caller passed full bytes
                    // including the 0xF7B1 prefix).
                    br.ReadUInt32();
                    var savedSeq = br.ReadUInt32();
                    var savedAction = (Chorizite.ACProtocol.Enums.GameActionType)br.ReadUInt32();
                    ReadPayloadOnlySubclass(instance, br);
                    // ReadPayloadOnlySubclass invokes the subclass's full Read(),
                    // which calls base.Read on the 8 stitched zero bytes —
                    // that overwrites the header fields. Restore them.
                    action.OrderedSequence = savedSeq;
                    action.ActionType = savedAction;
                } else if (instance is S2C.Ordered_GameEvent ev) {
                    br.ReadUInt32();
                    var savedObjId = br.ReadUInt32();
                    var savedSeq = br.ReadUInt32();
                    var savedEvType = (Chorizite.ACProtocol.Enums.GameEventType)br.ReadUInt32();
                    ReadPayloadOnlySubclass(instance, br);
                    ev.OrderedObjectId = savedObjId;
                    ev.OrderedSequence = savedSeq;
                    ev.EventType = savedEvType;
                } else {
                    // Top-level non-action/event: skip the opcode bytes
                    // we prepended on the pack side.
                    br.ReadUInt32();
                    instance.Read(br);
                }
            } else {
                if (instance is C2S.Ordered_GameAction or S2C.Ordered_GameEvent) {
                    ReadPayloadOnlySubclass(instance, br);
                } else {
                    instance.Read(br);
                }
            }
        } else {
            // No typeName — use Chorizite's static dispatcher to discover the type from opcode.
            if (mode != "full") {
                throw new ArgumentException(
                    "headerMode='payload' requires an explicit typeName " +
                    "(payload-only bytes carry no opcode header).");
            }
            using var ms = new MemoryStream(bytes);
            using var br = new BinaryReader(ms, Encoding.UTF8, leaveOpen: true);
            var s2cHandler = new S2CMessageHandler();
            var c2sHandler = new C2SMessageHandler();
            // Try S2C first.
            ACMessage? result = null;
            try {
                result = s2cHandler.ProcessS2CMessage(br);
            } catch { /* not S2C — try C2S */ }
            if (result == null) {
                ms.Position = 0;
                try { result = c2sHandler.ProcessC2SMessage(br); }
                catch { /* nothing */ }
            }
            if (result == null) {
                throw new InvalidDataException(
                    $"Could not dispatch bytes (len {bytes.Length}) — opcode 0x{(bytes.Length >= 4 ? BitConverter.ToUInt32(bytes, 0) : 0):X8} unknown.");
            }
            instance = result;
            resolvedType = result.GetType();
        }

        var fields = SerializeToJson(instance);
        // Round-trip: re-pack and compare.
        var repack = ChoriziteWirePackMessage(resolvedType.Name, fields, mode);
        var origHex = Convert.ToHexString(bytes).ToLowerInvariant();
        bool match = string.Equals(origHex, repack.HexBytes, StringComparison.Ordinal);
        string? diff = null;
        if (!match) {
            int diffAt = -1;
            int n = Math.Min(bytes.Length, repack.ByteLen);
            var repackBytes = ParseHex(repack.HexBytes);
            for (int i = 0; i < n; i++) {
                if (bytes[i] != repackBytes[i]) { diffAt = i; break; }
            }
            if (diffAt < 0 && bytes.Length != repack.ByteLen) diffAt = n;
            diff = $"len-orig={bytes.Length} len-repack={repack.ByteLen} firstDiff@{diffAt:X4}";
        }
        return new WireUnpackResult(
            MessageType: resolvedType.Name,
            FullName: resolvedType.FullName!,
            HeaderMode: mode,
            Fields: fields,
            Roundtrip: match,
            RoundtripDiff: diff);
    }

    /// <summary>
    /// Mirror of <see cref="EmitPayloadOnlySubclass"/> on the read side:
    /// invoke the leaf subclass's <c>Read</c> after the caller has
    /// already consumed the header. We fake this by setting the
    /// underlying stream's position past the header offset that the
    /// generated <c>base.Read</c> would itself consume — equivalent
    /// to inlining the subclass's Read body.
    ///
    /// Approach: temporarily wrap the reader with a memory stream that
    /// starts at the caller's current position, prepended with zero
    /// bytes for the base header so <c>base.Read</c> happily consumes
    /// them as no-ops (Ordered_GameAction.Read just reads sequence +
    /// actionType into the instance; we overwrite those after).
    /// </summary>
    private static void ReadPayloadOnlySubclass(ACMessage instance, BinaryReader reader) {
        int skip = instance switch {
            C2S.Ordered_GameAction => 8,
            S2C.Ordered_GameEvent => 12,
            _ => 0,
        };
        if (skip == 0) {
            instance.Read(reader);
            return;
        }
        // Read remainder, prepend zeros, re-wrap. Use BaseStream.Read directly
        // because MemoryStream.GetBuffer() can throw "buffer cannot be accessed"
        // when the stream was constructed from a byte[] (publicly visible: false).
        var rest = ReadAllBytes(reader);
        var stitched = new byte[skip + rest.Length];
        Array.Copy(rest, 0, stitched, skip, rest.Length);
        using var ms = new MemoryStream(stitched);
        using var br = new BinaryReader(ms);
        instance.Read(br);
        // Preserve action/event metadata from the caller's setup.
    }

    private static byte[] ReadAllBytes(BinaryReader br) {
        using var dst = new MemoryStream();
        var buf = new byte[4096];
        int read;
        while ((read = br.BaseStream.Read(buf, 0, buf.Length)) > 0) dst.Write(buf, 0, read);
        return dst.ToArray();
    }

    // ─────────────────────────────────────────────────────────────────
    //  JSON ↔ instance helpers
    // ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Populate <paramref name="instance"/>'s public fields from
    /// <paramref name="node"/>. Handles primitives, enums (by name or
    /// integer), <see cref="Vector3"/>, nested <c>IACDataType</c> types
    /// (recursively populated), and <c>List&lt;T&gt;</c> of either.
    ///
    /// JSON field naming is case-insensitive (matches the C# field
    /// names). camelCase + PascalCase + snake_case all work.
    /// </summary>
    private static void PopulateFromJson(object instance, JsonNode node) {
        var fieldsByLower = new Dictionary<string, FieldInfo>(StringComparer.OrdinalIgnoreCase);
        // Walk type chain so inherited fields (OrderedSequence, ActionType,
        // OrderedObjectId, EventType) on Ordered_GameAction / Ordered_GameEvent
        // are reachable from JSON.
        for (var t = instance.GetType(); t != null && t != typeof(object); t = t.BaseType) {
            foreach (var f in t.GetFields(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)) {
                if (!fieldsByLower.ContainsKey(f.Name)) fieldsByLower[f.Name] = f;
                var snake = ToSnakeCase(f.Name);
                if (!fieldsByLower.ContainsKey(snake)) fieldsByLower[snake] = f;
            }
        }
        foreach (var kv in node.AsObject()) {
            if (!fieldsByLower.TryGetValue(kv.Key, out var field)) {
                var valid = string.Join(", ", fieldsByLower.Values
                    .Select(f => f.Name)
                    .Distinct(StringComparer.Ordinal)
                    .OrderBy(n => n, StringComparer.Ordinal));
                throw new ArgumentException(
                    $"Unknown field '{kv.Key}' for {instance.GetType().Name}. Valid: {valid}");
            }
            if (kv.Value == null) continue;
            object? converted = ConvertJsonToType(kv.Value, field.FieldType);
            if (converted != null) field.SetValue(instance, converted);
        }
    }

    private static object? ConvertJsonToType(JsonNode node, Type target) {
        // Enum: int OR name.
        if (target.IsEnum) {
            if (node.GetValueKind() == JsonValueKind.String) {
                var s = node.GetValue<string>();
                if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) {
                    var raw = Convert.ToUInt64(s.Substring(2), 16);
                    return Enum.ToObject(target, raw);
                }
                if (Enum.TryParse(target, s, ignoreCase: true, out var parsed)) return parsed;
                throw new ArgumentException($"Cannot parse enum {target.Name} from '{s}'");
            }
            return Enum.ToObject(target, node.GetValue<long>());
        }
        // Primitive numeric / bool / string. Range-checked narrowing so an
        // out-of-range JSON value FAILs instead of silently wrapping.
        if (target == typeof(uint))   return (uint)CheckUnsignedRange(node, uint.MaxValue, "uint");
        if (target == typeof(int))    { var v = ReadAsInt64(node); RequireInRange(node, v, int.MinValue, int.MaxValue, "int"); return (int)v; }
        if (target == typeof(ushort)) return (ushort)CheckUnsignedRange(node, ushort.MaxValue, "ushort");
        if (target == typeof(short))  { var v = ReadAsInt64(node); RequireInRange(node, v, short.MinValue, short.MaxValue, "short"); return (short)v; }
        if (target == typeof(byte))   return (byte)CheckUnsignedRange(node, byte.MaxValue, "byte");
        if (target == typeof(sbyte))  { var v = ReadAsInt64(node); RequireInRange(node, v, sbyte.MinValue, sbyte.MaxValue, "sbyte"); return (sbyte)v; }
        if (target == typeof(ulong))  return CheckUnsignedRange(node, ulong.MaxValue, "ulong");
        if (target == typeof(long))   return ReadAsInt64(node);
        if (target == typeof(float))  return (float)ReadAsDouble(node);
        if (target == typeof(double)) return ReadAsDouble(node);
        if (target == typeof(bool))   return node.GetValue<bool>();
        if (target == typeof(string)) return node.GetValue<string>();
        // Vector3.
        if (target == typeof(Vector3)) {
            var o = node.AsObject();
            float x = (float)(o.ContainsKey("x") ? ReadAsDouble(o["x"]!) : o.ContainsKey("X") ? ReadAsDouble(o["X"]!) : 0);
            float y = (float)(o.ContainsKey("y") ? ReadAsDouble(o["y"]!) : o.ContainsKey("Y") ? ReadAsDouble(o["Y"]!) : 0);
            float z = (float)(o.ContainsKey("z") ? ReadAsDouble(o["z"]!) : o.ContainsKey("Z") ? ReadAsDouble(o["Z"]!) : 0);
            return new Vector3(x, y, z);
        }
        if (target == typeof(Quaternion)) {
            var o = node.AsObject();
            float x = (float)(o.ContainsKey("x") ? ReadAsDouble(o["x"]!) : 0);
            float y = (float)(o.ContainsKey("y") ? ReadAsDouble(o["y"]!) : 0);
            float z = (float)(o.ContainsKey("z") ? ReadAsDouble(o["z"]!) : 0);
            float w = (float)(o.ContainsKey("w") ? ReadAsDouble(o["w"]!) : 0);
            return new Quaternion(x, y, z, w);
        }
        // List<T>.
        if (target.IsGenericType && target.GetGenericTypeDefinition() == typeof(List<>)) {
            var elem = target.GetGenericArguments()[0];
            var list = (IList)Activator.CreateInstance(target)!;
            foreach (var n in node.AsArray()) {
                if (n == null) continue;
                var conv = ConvertJsonToType(n, elem);
                if (conv != null) list.Add(conv);
            }
            return list;
        }
        // Nested IACDataType / arbitrary class: recurse. Always instantiate
        // (even for empty objects) so the underlying Write() has a non-null
        // ref. Generated types use field-initializers but only on the new()
        // line — outer class's bare `public Foo Foo;` defaults to null.
        if (!target.IsValueType) {
            var inst = Activator.CreateInstance(target);
            if (inst != null) {
                if (node is JsonObject) PopulateFromJson(inst, node);
                return inst;
            }
        }
        // Last-ditch: try System.Text.Json.
        return JsonSerializer.Deserialize(node.ToJsonString(), target, WireConformanceJsonOpts);
    }

    // All numeric parsers normalize through long/ulong, then the caller
    // (ConvertJsonToType) casts to the target field width. Reading from a
    // JsonValue created with a narrower type (uint, ushort, byte, …) via
    // GetValue<long>() throws InvalidOperationException, so we read the raw
    // double/long via TryGetValue and convert.
    private static long ReadAsInt64(JsonNode node) {
        if (node.GetValueKind() == JsonValueKind.String) {
            var s = node.GetValue<string>();
            if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) {
                return Convert.ToInt64(s.Substring(2), 16);
            }
            return Convert.ToInt64(s, System.Globalization.CultureInfo.InvariantCulture);
        }
        // JsonNumber — try the widest integer first, then double-truncate.
        if (node is JsonValue jv) {
            if (jv.TryGetValue<long>(out var l64))   return l64;
            if (jv.TryGetValue<int>(out var i32))    return i32;
            if (jv.TryGetValue<uint>(out var u32))   return u32;
            if (jv.TryGetValue<ushort>(out var us))  return us;
            if (jv.TryGetValue<short>(out var s16))  return s16;
            if (jv.TryGetValue<byte>(out var b))     return b;
            if (jv.TryGetValue<sbyte>(out var sb))   return sb;
            if (jv.TryGetValue<double>(out var d))   return (long)d;
            if (jv.TryGetValue<float>(out var f))    return (long)f;
        }
        throw new InvalidOperationException($"Cannot read integer from JsonNode kind={node.GetValueKind()}");
    }

    private static ulong ReadAsUInt64(JsonNode node) {
        if (node.GetValueKind() == JsonValueKind.String) {
            var s = node.GetValue<string>();
            if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) {
                return Convert.ToUInt64(s.Substring(2), 16);
            }
            return Convert.ToUInt64(s, System.Globalization.CultureInfo.InvariantCulture);
        }
        if (node is JsonValue jv) {
            if (jv.TryGetValue<ulong>(out var u64))  return u64;
            if (jv.TryGetValue<long>(out var l64))   return (ulong)l64;
            if (jv.TryGetValue<uint>(out var u32))   return u32;
            if (jv.TryGetValue<int>(out var i32))    return (ulong)i32;
            if (jv.TryGetValue<ushort>(out var us))  return us;
            if (jv.TryGetValue<short>(out var s16))  return (ulong)s16;
            if (jv.TryGetValue<byte>(out var b))     return b;
            if (jv.TryGetValue<double>(out var d))   return (ulong)d;
            if (jv.TryGetValue<float>(out var f))    return (ulong)f;
        }
        throw new InvalidOperationException($"Cannot read unsigned integer from JsonNode kind={node.GetValueKind()}");
    }

    private static double ReadAsDouble(JsonNode node) {
        if (node.GetValueKind() == JsonValueKind.String) {
            return double.Parse(node.GetValue<string>(), System.Globalization.CultureInfo.InvariantCulture);
        }
        if (node is JsonValue jv) {
            if (jv.TryGetValue<double>(out var d))   return d;
            if (jv.TryGetValue<float>(out var f))    return f;
            if (jv.TryGetValue<long>(out var l))     return l;
            if (jv.TryGetValue<ulong>(out var u))    return u;
            if (jv.TryGetValue<int>(out var i))      return i;
            if (jv.TryGetValue<uint>(out var u2))    return u2;
        }
        throw new InvalidOperationException($"Cannot read number from JsonNode kind={node.GetValueKind()}");
    }

    private static void RequireInRange(JsonNode node, long value, long min, long max, string typeName) {
        if (value < min || value > max) {
            throw new ArgumentException(
                $"'{node.GetValueKind()}' value {value} out of range for {typeName}");
        }
    }

    // Read a non-negative integer and verify it fits the unsigned target.
    // Negative JSON inputs (which would wrap) are rejected; values up to
    // ulong.MaxValue are read without going through the signed path.
    private static ulong CheckUnsignedRange(JsonNode node, ulong max, string typeName) {
        if (IsNegativeNumeric(node)) {
            throw new ArgumentException(
                $"'{node.GetValueKind()}' value {ReadAsInt64(node)} out of range for {typeName}");
        }
        var value = ReadAsUInt64(node);
        if (value > max) {
            throw new ArgumentException(
                $"'{node.GetValueKind()}' value {value} out of range for {typeName}");
        }
        return value;
    }

    private static bool IsNegativeNumeric(JsonNode node) {
        if (node.GetValueKind() == JsonValueKind.String) {
            var s = node.GetValue<string>().Trim();
            return s.StartsWith("-", StringComparison.Ordinal);
        }
        if (node is JsonValue jv) {
            if (jv.TryGetValue<long>(out var l))   return l < 0;
            if (jv.TryGetValue<double>(out var d)) return d < 0;
        }
        return false;
    }

    private static readonly JsonSerializerOptions WireConformanceJsonOpts = new() {
        WriteIndented = false,
    };

    /// <summary>
    /// Reflect over an instance's public fields and produce a JsonNode
    /// representation. Vectors and nested IACDataType are expanded; enums
    /// emit their string name + numeric value as
    /// <c>{ name: "Walk", value: 1 }</c> for human-readable diffs.
    /// </summary>
    private static JsonNode SerializeToJson(object instance) {
        var obj = new JsonObject();
        // Walk up the type chain so inherited fields (e.g. OrderedSequence,
        // ActionType on Ordered_GameAction subclasses) are included. The
        // default `GetFields(BindingFlags.Public | BindingFlags.Instance)`
        // *does* return inherited public fields, but defensively iterate the
        // type chain to be safe + deterministic ordering.
        var fields = new List<FieldInfo>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var t = instance.GetType(); t != null && t != typeof(object); t = t.BaseType) {
            foreach (var f in t.GetFields(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)) {
                if (seen.Add(f.Name)) fields.Add(f);
            }
        }
        foreach (var f in fields) {
            var v = f.GetValue(instance);
            obj[f.Name] = ValueToJson(v);
        }
        return obj;
    }

    private static JsonNode? ValueToJson(object? v) {
        if (v == null) return null;
        var t = v.GetType();
        if (t.IsEnum) {
            // Emit the enum's symbolic name as a string. PopulateFromJson
            // handles both "Name" and numeric on the way back, so this
            // round-trips. Symbol names are also human-diff-friendly in
            // mismatch reports.
            return JsonValue.Create(v.ToString());
        }
        if (t == typeof(uint)) return JsonValue.Create((uint)v);
        if (t == typeof(int)) return JsonValue.Create((int)v);
        if (t == typeof(ushort)) return JsonValue.Create((ushort)v);
        if (t == typeof(short)) return JsonValue.Create((short)v);
        if (t == typeof(byte)) return JsonValue.Create((byte)v);
        if (t == typeof(sbyte)) return JsonValue.Create((sbyte)v);
        if (t == typeof(ulong)) return JsonValue.Create((ulong)v);
        if (t == typeof(long)) return JsonValue.Create((long)v);
        if (t == typeof(float)) return JsonValue.Create((float)v);
        if (t == typeof(double)) return JsonValue.Create((double)v);
        if (t == typeof(bool)) return JsonValue.Create((bool)v);
        if (t == typeof(string)) return JsonValue.Create((string)v);
        if (t == typeof(Vector3)) {
            var v3 = (Vector3)v;
            return new JsonObject { ["x"] = v3.X, ["y"] = v3.Y, ["z"] = v3.Z };
        }
        if (t == typeof(Quaternion)) {
            var q = (Quaternion)v;
            return new JsonObject { ["x"] = q.X, ["y"] = q.Y, ["z"] = q.Z, ["w"] = q.W };
        }
        if (v is IList list && t.IsGenericType) {
            var arr = new JsonArray();
            foreach (var el in list) arr.Add(ValueToJson(el));
            return arr;
        }
        if (v is byte[] ba) return JsonValue.Create(Convert.ToHexString(ba).ToLowerInvariant());
        // Generic object: recurse.
        if (!t.IsPrimitive) {
            return SerializeToJson(v);
        }
        return JsonValue.Create(v.ToString());
    }

    private static byte[] ParseHex(string hex) {
        if (string.IsNullOrEmpty(hex)) return Array.Empty<byte>();
        // Strip whitespace + optional 0x prefix.
        var sb = new StringBuilder(hex.Length);
        foreach (var c in hex) {
            if (char.IsWhiteSpace(c)) continue;
            sb.Append(c);
        }
        var s = sb.ToString();
        if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) s = s.Substring(2);
        if ((s.Length & 1) != 0) throw new ArgumentException("hex length must be even");
        var bytes = new byte[s.Length / 2];
        for (int i = 0; i < bytes.Length; i++) {
            bytes[i] = Convert.ToByte(s.Substring(i * 2, 2), 16);
        }
        return bytes;
    }

    private static string ToSnakeCase(string s) {
        var sb = new StringBuilder(s.Length + 4);
        for (int i = 0; i < s.Length; i++) {
            var c = s[i];
            if (char.IsUpper(c) && i > 0) sb.Append('_');
            sb.Append(char.ToLowerInvariant(c));
        }
        return sb.ToString();
    }
}
