using Microsoft.Extensions.Logging.Abstractions;
using WorldBuilder.Shared.Documents;

namespace WorldBuilder.Tests;

public class FileStorageServiceTests {
    [Fact]
    public async Task CreateUpdatesAsync_PersistsSharedBatchMetadata() {
        var tempDir = Path.Combine(Path.GetTempPath(), $"wb-storage-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tempDir);

        try {
            using var storage = new FileStorageService(tempDir, NullLogger<DocumentStorageService>.Instance);

            var batch = await storage.CreateUpdatesAsync(new[] {
                (documentId: "docA", type: "delta", update: new byte[] { 1 }),
                (documentId: "docA", type: "delta", update: new byte[] { 2 }),
                (documentId: "docA", type: "delta", update: new byte[] { 3 }),
            });

            Assert.Equal(3, batch.Count);

            var persisted = await storage.GetDocumentUpdatesAsync("docA");
            Assert.Equal(3, persisted.Count);

            var expectedClientId = batch[0].ClientId;
            var expectedTimestamp = batch[0].Timestamp;

            Assert.All(batch, update => {
                Assert.Equal(expectedClientId, update.ClientId);
                Assert.Equal(expectedTimestamp, update.Timestamp);
            });

            Assert.All(persisted, update => {
                Assert.Equal(expectedClientId, update.ClientId);
                Assert.Equal(expectedTimestamp, update.Timestamp);
            });

            Assert.Equal(batch.Select(x => x.Id), persisted.Select(x => x.Id));
        }
        finally {
            Directory.Delete(tempDir, recursive: true);
        }
    }
}
