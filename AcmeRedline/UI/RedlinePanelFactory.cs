using System;
using System.Runtime.CompilerServices;
using AcmeRedline.Lib;
using AcmeRedline.Services;
using Microsoft.Extensions.Logging;
using RmlUi;

namespace AcmeRedline.UI {
    /// <summary>
    /// The single place in this assembly outside <see cref="RedlinePanel"/> that names an RmlUi
    /// type — deliberately isolated behind <see cref="MethodImplOptions.NoInlining"/>.
    ///
    /// The CLR resolves the types a method body mentions when it JITs that body, so if the
    /// RmlUi plugin is not installed the failure surfaces as an exception thrown *at the call
    /// to* <see cref="Create"/> rather than poisoning the caller's own frame. NoInlining is
    /// load-bearing: without it the JIT could fold this body into
    /// <c>AcmeRedlinePlugin.Initialize</c> and take the whole plugin down instead.
    /// </summary>
    internal static class RedlinePanelFactory {
        /// <summary>
        /// Build the panel. <paramref name="rmlUiPlugin"/> is the RmlUi plugin instance obtained
        /// from <c>IPluginManager.GetPlugin("RmlUi")?.Instance</c> as a bare <see cref="object"/>,
        /// so the caller never mentions the type.
        /// </summary>
        /// <exception cref="System.IO.FileNotFoundException">RmlUi.dll is not loadable.</exception>
        /// <exception cref="TypeLoadException">RmlUi.dll is present but incompatible.</exception>
        /// <exception cref="InvalidCastException">The object is not an RmlUiPlugin.</exception>
        [MethodImpl(MethodImplOptions.NoInlining)]
        internal static IRedlinePanel Create(object rmlUiPlugin,
                                             SelectionService selection, StatusReader status,
                                             QueueWriter queue, KitMeta kit, RedlineSettings settings,
                                             string rmlPath, Func<string?> authorProvider, ILogger log) {
            return new RedlinePanel((RmlUiPlugin)rmlUiPlugin, selection, status, queue, kit,
                                    settings, rmlPath, authorProvider, log);
        }
    }
}
