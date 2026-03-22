using Microsoft.Extensions.DependencyInjection;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Services;

namespace WorldBuilder.Shared.Lib.Extensions {
    public static class ServiceCollectionExtensions {
        /// <summary>
        /// Registers all WorldBuilder.Shared services into the DI container.
        /// Call this from both the UI host and the Terminal host to get a
        /// consistent set of services.
        /// </summary>
        public static IServiceCollection AddWorldBuilder(this IServiceCollection collection) {
            collection.AddSingleton<ITerrainService, TerrainService>();
            collection.AddSingleton<IObjectPlacementService, ObjectPlacementService>();
            collection.AddSingleton<IDungeonService, DungeonService>();
            collection.AddSingleton<IStampService, StampService>();
            collection.AddSingleton<IOntologyService, OntologyService>();
            return collection;
        }
    }
}