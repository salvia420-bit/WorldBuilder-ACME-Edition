using System;
using System.Collections.Generic;
using System.Text.Json;

namespace WorldBuilder.Shared.Lib.AceDb {

    /// <summary>Starter scaffold for scalar weenie properties (JSON-defined templates).</summary>
    public sealed class WeenieTemplateDefinition {
        public string Id { get; init; } = "";
        public string Title { get; init; } = "";
        public string? Description { get; init; }
        public uint WeenieType { get; init; }
        /// <summary>True when the bundle explicitly provided <c>weenieType</c> (not the default fallback).
        /// weenie-template-apply uses this to decide whether to overwrite the weenie's existing type. (F234)</summary>
        public bool WeenieTypeExplicit { get; init; }
        public IReadOnlyList<(ushort Type, int Value)> Ints { get; init; } = Array.Empty<(ushort, int)>();
        public IReadOnlyList<(ushort Type, long Value)> Int64s { get; init; } = Array.Empty<(ushort, long)>();
        public IReadOnlyList<(ushort Type, bool Value)> Bools { get; init; } = Array.Empty<(ushort, bool)>();
        public IReadOnlyList<(ushort Type, double Value)> Floats { get; init; } = Array.Empty<(ushort, double)>();
        public IReadOnlyList<(ushort Type, string Value)> Strings { get; init; } = Array.Empty<(ushort, string)>();
        public IReadOnlyList<(ushort Type, uint Value)> DataIds { get; init; } = Array.Empty<(ushort, uint)>();
        public IReadOnlyList<(ushort Type, ulong Value)> InstanceIds { get; init; } = Array.Empty<(ushort, ulong)>();
    }

    public static class WeenieTemplateJson {
        /// <summary>Parses a JSON array of templates, or a single template object.</summary>
        public static IReadOnlyList<WeenieTemplateDefinition> ParseBundle(string json)
            => ParseBundle(json, out _);

        /// <summary>
        /// Parses a JSON array of templates, or a single template object, collecting a
        /// per-template / per-row diagnostic for every element or row that was skipped or
        /// rejected so callers can surface them instead of silently dropping data. (F238)
        /// </summary>
        public static IReadOnlyList<WeenieTemplateDefinition> ParseBundle(string json, out IReadOnlyList<string> warnings) {
            var warn = new List<string>();
            warnings = warn;
            json = json.Trim();
            if (string.IsNullOrEmpty(json)) return Array.Empty<WeenieTemplateDefinition>();

            using var doc = JsonDocument.Parse(json, new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
            var root = doc.RootElement;
            var list = new List<WeenieTemplateDefinition>();

            if (root.ValueKind == JsonValueKind.Array) {
                int idx = 0;
                foreach (var el in root.EnumerateArray()) {
                    if (TryParseOne(el, $"template[{idx}]", warn, out var d) && d != null)
                        list.Add(d);
                    idx++;
                }
            }
            else if (root.ValueKind == JsonValueKind.Object) {
                if (TryParseOne(root, "template[0]", warn, out var d) && d != null)
                    list.Add(d);
            }

            return list;
        }

        static bool TryParseOne(JsonElement el, string ctx, List<string> warn, out WeenieTemplateDefinition? def) {
            def = null;
            if (el.ValueKind != JsonValueKind.Object) {
                warn.Add($"{ctx}: not a JSON object");
                return false;
            }

            var id = GetString(el, "id");
            var title = GetString(el, "title");
            if (string.IsNullOrWhiteSpace(id)) { warn.Add($"{ctx}: missing id"); return false; }
            if (string.IsNullOrWhiteSpace(title)) { warn.Add($"{ctx}: missing title"); return false; }

            var desc = GetString(el, "description");
            if (string.IsNullOrWhiteSpace(desc)) desc = null;

            // weenieType: absent → default 1; present-but-unparseable → reject the template
            // (do NOT silently fall back to 1, which would corrupt the weenie's type). (F238)
            uint weenieType = 1;
            bool weenieTypePresent = el.TryGetProperty("weenieType", out var wtEl);
            bool weenieTypeExplicit = false;
            if (weenieTypePresent) {
                if (wtEl.ValueKind == JsonValueKind.Number && wtEl.TryGetUInt32(out weenieType)) {
                    weenieTypeExplicit = true;
                }
                else {
                    warn.Add($"{ctx}: weenieType present but not a uint32");
                    return false;
                }
            }

            def = new WeenieTemplateDefinition {
                Id = id.Trim(),
                Title = title.Trim(),
                Description = desc?.Trim(),
                WeenieType = weenieType,
                WeenieTypeExplicit = weenieTypeExplicit,
                Ints = ReadIntProps(el, "ints", ctx, warn),
                Int64s = ReadInt64Props(el, "int64s", ctx, warn),
                Bools = ReadBoolProps(el, "bools", ctx, warn),
                Floats = ReadFloatProps(el, "floats", ctx, warn),
                Strings = ReadStringProps(el, "strings", ctx, warn),
                DataIds = ReadUintProps(el, "dataIds", ctx, warn),
                InstanceIds = ReadUlongProps(el, "instanceIds", ctx, warn),
            };
            return true;
        }

        static string? GetString(JsonElement parent, string name) {
            if (!parent.TryGetProperty(name, out var p)) return null;
            return p.ValueKind == JsonValueKind.String ? p.GetString() : null;
        }

        static List<(ushort, int)> ReadIntProps(JsonElement parent, string arrayName, string ctx, List<string> warn) {
            var list = new List<(ushort, int)>();
            if (!parent.TryGetProperty(arrayName, out var arr) || arr.ValueKind != JsonValueKind.Array) return list;
            int i = 0;
            foreach (var item in arr.EnumerateArray()) {
                if (!item.TryGetProperty("type", out var t) || !TryGetUInt16(t, out var type)) { warn.Add($"{ctx}: {arrayName}[{i}] type not a uint16"); i++; continue; }
                if (item.TryGetProperty("value", out var v) && v.TryGetInt32(out var value)) list.Add((type, value));
                else warn.Add($"{ctx}: {arrayName}[{i}] value not an int32");
                i++;
            }
            return list;
        }

        static List<(ushort, long)> ReadInt64Props(JsonElement parent, string arrayName, string ctx, List<string> warn) {
            var list = new List<(ushort, long)>();
            if (!parent.TryGetProperty(arrayName, out var arr) || arr.ValueKind != JsonValueKind.Array) return list;
            int i = 0;
            foreach (var item in arr.EnumerateArray()) {
                if (!item.TryGetProperty("type", out var t) || !TryGetUInt16(t, out var type)) { warn.Add($"{ctx}: {arrayName}[{i}] type not a uint16"); i++; continue; }
                if (item.TryGetProperty("value", out var v) && v.TryGetInt64(out var value)) list.Add((type, value));
                else warn.Add($"{ctx}: {arrayName}[{i}] value not an int64");
                i++;
            }
            return list;
        }

        static List<(ushort, bool)> ReadBoolProps(JsonElement parent, string arrayName, string ctx, List<string> warn) {
            var list = new List<(ushort, bool)>();
            if (!parent.TryGetProperty(arrayName, out var arr) || arr.ValueKind != JsonValueKind.Array) return list;
            int i = 0;
            foreach (var item in arr.EnumerateArray()) {
                if (!item.TryGetProperty("type", out var t) || !TryGetUInt16(t, out var type)) { warn.Add($"{ctx}: {arrayName}[{i}] type not a uint16"); i++; continue; }
                if (item.TryGetProperty("value", out var v) && (v.ValueKind == JsonValueKind.True || v.ValueKind == JsonValueKind.False)) list.Add((type, v.GetBoolean()));
                else warn.Add($"{ctx}: {arrayName}[{i}] value not a bool");
                i++;
            }
            return list;
        }

        static List<(ushort, double)> ReadFloatProps(JsonElement parent, string arrayName, string ctx, List<string> warn) {
            var list = new List<(ushort, double)>();
            if (!parent.TryGetProperty(arrayName, out var arr) || arr.ValueKind != JsonValueKind.Array) return list;
            int i = 0;
            foreach (var item in arr.EnumerateArray()) {
                if (!item.TryGetProperty("type", out var t) || !TryGetUInt16(t, out var type)) { warn.Add($"{ctx}: {arrayName}[{i}] type not a uint16"); i++; continue; }
                if (item.TryGetProperty("value", out var v) && v.TryGetDouble(out var value)) list.Add((type, value));
                else warn.Add($"{ctx}: {arrayName}[{i}] value not a double");
                i++;
            }
            return list;
        }

        static List<(ushort, string)> ReadStringProps(JsonElement parent, string arrayName, string ctx, List<string> warn) {
            var list = new List<(ushort, string)>();
            if (!parent.TryGetProperty(arrayName, out var arr) || arr.ValueKind != JsonValueKind.Array) return list;
            int i = 0;
            foreach (var item in arr.EnumerateArray()) {
                if (!item.TryGetProperty("type", out var t) || !TryGetUInt16(t, out var type)) { warn.Add($"{ctx}: {arrayName}[{i}] type not a uint16"); i++; continue; }
                if (item.TryGetProperty("value", out var v)) {
                    var s = v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : v.ToString();
                    list.Add((type, s));
                }
                else warn.Add($"{ctx}: {arrayName}[{i}] missing value");
                i++;
            }
            return list;
        }

        static List<(ushort, uint)> ReadUintProps(JsonElement parent, string arrayName, string ctx, List<string> warn) {
            var list = new List<(ushort, uint)>();
            if (!parent.TryGetProperty(arrayName, out var arr) || arr.ValueKind != JsonValueKind.Array) return list;
            int i = 0;
            foreach (var item in arr.EnumerateArray()) {
                if (!item.TryGetProperty("type", out var t) || !TryGetUInt16(t, out var type)) { warn.Add($"{ctx}: {arrayName}[{i}] type not a uint16"); i++; continue; }
                if (item.TryGetProperty("value", out var v) && TryGetUInt32(v, out var value)) list.Add((type, value));
                else warn.Add($"{ctx}: {arrayName}[{i}] value not a uint32");
                i++;
            }
            return list;
        }

        static List<(ushort, ulong)> ReadUlongProps(JsonElement parent, string arrayName, string ctx, List<string> warn) {
            var list = new List<(ushort, ulong)>();
            if (!parent.TryGetProperty(arrayName, out var arr) || arr.ValueKind != JsonValueKind.Array) return list;
            int i = 0;
            foreach (var item in arr.EnumerateArray()) {
                if (!item.TryGetProperty("type", out var t) || !TryGetUInt16(t, out var type)) { warn.Add($"{ctx}: {arrayName}[{i}] type not a uint16"); i++; continue; }
                if (item.TryGetProperty("value", out var v) && TryGetUInt64(v, out var value)) list.Add((type, value));
                else warn.Add($"{ctx}: {arrayName}[{i}] value not a uint64");
                i++;
            }
            return list;
        }

        static bool TryGetUInt32(JsonElement v, out uint value) {
            value = 0;
            if (v.ValueKind == JsonValueKind.Number && v.TryGetUInt32(out value)) return true;
            if (v.ValueKind == JsonValueKind.String && uint.TryParse(v.GetString(), System.Globalization.NumberStyles.Integer, null, out value)) return true;
            if (v.ValueKind == JsonValueKind.String) {
                var s = v.GetString();
                if (s != null && s.StartsWith("0x", StringComparison.OrdinalIgnoreCase) &&
                    uint.TryParse(s.AsSpan(2), System.Globalization.NumberStyles.HexNumber, null, out value))
                    return true;
            }
            return false;
        }

        static bool TryGetUInt64(JsonElement v, out ulong value) {
            value = 0;
            if (v.ValueKind == JsonValueKind.Number && v.TryGetUInt64(out value)) return true;
            if (v.ValueKind == JsonValueKind.String && ulong.TryParse(v.GetString(), System.Globalization.NumberStyles.Integer, null, out value)) return true;
            return false;
        }

        static bool TryGetUInt16(JsonElement t, out ushort type) {
            type = 0;
            if (t.ValueKind == JsonValueKind.Number && t.TryGetInt32(out var i) && i is >= 0 and <= 65535) {
                type = (ushort)i;
                return true;
            }
            if (t.ValueKind == JsonValueKind.String && ushort.TryParse(t.GetString(), out type)) return true;
            return false;
        }
    }
}
