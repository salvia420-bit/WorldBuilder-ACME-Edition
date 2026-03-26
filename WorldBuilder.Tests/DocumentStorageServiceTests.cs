using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using WorldBuilder.Shared.Documents;

namespace WorldBuilder.Tests;

public class DocumentStorageServiceTests {
    [Fact]
    public async Task CleanupOldUpdatesAsync_WithMaxAgeAndMaxUpdates_DoesNotThrowAndCleansExpectedRows() {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();

        var options = new DbContextOptionsBuilder<DocumentDbContext>()
            .UseSqlite(connection)
            .Options;

        await using var context = new DocumentDbContext(options);
        await context.Database.EnsureCreatedAsync();

        using var storage = new DocumentStorageService(context, NullLogger<DocumentStorageService>.Instance);

        await storage.CreateDocumentAsync("doc-1", "delta", new byte[] { 0x01 });

        await storage.CreateUpdatesAsync(new[] {
            ("doc-1", "delta", new byte[] { 0x01 }),
            ("doc-1", "delta", new byte[] { 0x02 }),
            ("doc-1", "delta", new byte[] { 0x03 }),
        });

        var deleted = await storage.CleanupOldUpdatesAsync("doc-1", maxUpdates: 2, maxAge: TimeSpan.FromDays(365));
        var remaining = await storage.GetDocumentUpdatesAsync("doc-1");

        Assert.Equal(1, deleted);
        Assert.Equal(2, remaining.Count);
    }

    [Fact]
    public async Task CleanupAllDocumentsAsync_DoesNotDeadlock_WhenMultipleDocumentsExist() {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();

        var options = new DbContextOptionsBuilder<DocumentDbContext>()
            .UseSqlite(connection)
            .Options;

        await using var context = new DocumentDbContext(options);
        await context.Database.EnsureCreatedAsync();

        using var storage = new DocumentStorageService(context, NullLogger<DocumentStorageService>.Instance);

        await storage.CreateDocumentAsync("doc-a", "delta", new byte[] { 0x01 });
        await storage.CreateDocumentAsync("doc-b", "delta", new byte[] { 0x01 });

        await storage.CreateUpdatesAsync(new[] {
            ("doc-a", "delta", new byte[] { 0x01 }),
            ("doc-a", "delta", new byte[] { 0x02 }),
            ("doc-a", "delta", new byte[] { 0x03 }),
            ("doc-b", "delta", new byte[] { 0x01 }),
            ("doc-b", "delta", new byte[] { 0x02 }),
            ("doc-b", "delta", new byte[] { 0x03 }),
        });

        var cleanupTask = storage.CleanupAllDocumentsAsync(maxUpdatesPerDocument: 1);
        var completedTask = await Task.WhenAny(cleanupTask, Task.Delay(TimeSpan.FromSeconds(2)));

        Assert.Same(cleanupTask, completedTask);
        Assert.Equal(4, await cleanupTask);
    }
}
