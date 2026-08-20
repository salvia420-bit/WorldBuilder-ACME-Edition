using System.Text.Json.Serialization;

namespace AcmeRedline.Model {
    /// <summary>
    /// One line of &lt;queueDir&gt;/redline-status.jsonl.
    ///
    /// This file is WRITTEN BY THE PIPELINE, never by the plugin. The plugin opens it
    /// read-only (FileShare.ReadWrite so a concurrent pipeline append is not blocked)
    /// and folds the events into the "my reports" list and the status-tint overlay.
    ///
    /// Shape is the FROZEN <c>statusEvent</c> from tools/dat-patch/redline/schema_v1.json:
    /// required {entryId, at, state}; optional {release, note, by}. Field is <c>entryId</c>
    /// (NOT "id"), and state is one of exactly {queued, in-progress, fixed} — the kit tag a fix
    /// ships in travels in <see cref="Release"/>, not inside the state string.
    ///
    /// Derived current state per entry = the LAST event for that entryId
    /// (queue_worker.derive_status; docs/redline/SCHEMA.md §3).
    /// </summary>
    public class RedlineStatusEvent {
        /// <summary>The <see cref="RedlineEntry.Id"/> this event refers to.</summary>
        [JsonPropertyName("entryId")]
        public string EntryId { get; set; } = "";

        /// <summary>ISO8601 UTC, when the pipeline emitted this event.</summary>
        [JsonPropertyName("at")]
        public string? At { get; set; }

        /// <summary>queued | in-progress | fixed — see <see cref="RedlineStatus"/>.</summary>
        [JsonPropertyName("state")]
        public string State { get; set; } = RedlineStatus.Queued;

        /// <summary>
        /// The kit tag a fix ships in (e.g. "acme-r9"). By convention required on state=fixed
        /// (status_writer.py refuses --state fixed without it). Null on other states.
        /// </summary>
        [JsonPropertyName("release")]
        public string? Release { get; set; }

        /// <summary>Optional free-text from the pipeline (what it did, or why it declined).</summary>
        [JsonPropertyName("note")]
        public string? Note { get; set; }

        /// <summary>Writer identity, e.g. "queue_worker.py" or "agent:texture-lane".</summary>
        [JsonPropertyName("by")]
        public string? By { get; set; }
    }
}
