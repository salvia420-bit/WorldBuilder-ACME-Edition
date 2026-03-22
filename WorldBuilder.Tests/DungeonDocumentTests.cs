using Microsoft.Extensions.Logging.Abstractions;
using System.Numerics;
using WorldBuilder.Shared.Documents;
using Xunit;

namespace WorldBuilder.Tests {
    public class DungeonDocumentTests {
        private static DungeonDocument CreateDocument() =>
            new DungeonDocument(NullLogger.Instance);

        [Fact]
        public void AddCell_AssignsCellNumber() {
            var doc = CreateDocument();
            doc.SetLandblockKey(0xAAAA);
            var cellNum = doc.AddCell(0x0001, 0, Vector3.Zero, Quaternion.Identity, new List<ushort> { 0x032A });
            Assert.Equal((ushort)0x0100, cellNum);
            Assert.Single(doc.Cells);
        }

        [Fact]
        public void ConnectPortals_CreatesBidirectionalLink() {
            var doc = CreateDocument();
            doc.SetLandblockKey(0xAAAA);
            var cellA = doc.AddCell(0x0001, 0, Vector3.Zero, Quaternion.Identity, new List<ushort>());
            var cellB = doc.AddCell(0x0001, 0, new Vector3(10, 0, 0), Quaternion.Identity, new List<ushort>());

            doc.ConnectPortals(cellA, 1, cellB, 2);

            var dcA = doc.GetCell(cellA);
            var dcB = doc.GetCell(cellB);
            Assert.NotNull(dcA);
            Assert.NotNull(dcB);
            Assert.Single(dcA!.CellPortals);
            Assert.Single(dcB!.CellPortals);
            Assert.Equal(cellB, dcA.CellPortals[0].OtherCellId);
            Assert.Equal(cellA, dcB.CellPortals[0].OtherCellId);
        }

        [Fact]
        public void RemoveCell_RemovesFromList() {
            var doc = CreateDocument();
            doc.SetLandblockKey(0xAAAA);
            var cellNum = doc.AddCell(0x0001, 0, Vector3.Zero, Quaternion.Identity, new List<ushort>());
            Assert.Single(doc.Cells);

            doc.RemoveCell(cellNum);
            Assert.Empty(doc.Cells);
        }
    }
}
