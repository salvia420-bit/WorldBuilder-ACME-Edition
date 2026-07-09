using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using ACE.DatLoader;
using ACE.DatLoader.FileTypes;

class Program
{
    static int Main()
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        
        string datDir = "/home/wbterminal/ac_base_dats";
        DatManager.Initialize(datDir, keepOpen: true, loadCell: true);
        
        if (DatManager.CellDat == null)
        {
            Console.Error.WriteLine("CellDat failed to load");
            return 1;
        }
        
        ushort lbKey = 0xA9B4;
        uint cellId = ((uint)lbKey << 16) | 0xFFFF;
        
        try
        {
            var cellLb = DatManager.CellDat.ReadFromDat<CellLandblock>(cellId);
            
            Console.WriteLine($"Landblock: 0x{lbKey:X4}");
            Console.WriteLine($"CellId: 0x{cellId:X8}");
            
            List<int> terrainTypes = new List<int>();
            for (int i = 0; i < cellLb.Terrain.Count; i++)
            {
                ushort terrain = cellLb.Terrain[i];
                int typeCode = (int)((terrain >> 2) & 0x1F);
                terrainTypes.Add(typeCode);
            }
            
            // Print raw terrain values and decoded types
            Console.WriteLine("\nRaw terrain values and decoded types:");
            for (int i = 0; i < 10; i++)
            {
                ushort rawTerrain = cellLb.Terrain[i];
                int typeCode = (int)((rawTerrain >> 2) & 0x1F);
                ushort road = CellLandblock.GetRoad(rawTerrain);
                ushort scenery = CellLandblock.GetScenery(rawTerrain);
                Console.WriteLine($"  Vertex {i}: raw=0x{rawTerrain:X4} type={typeCode:2d} road={road} scenery={scenery}");
            }
            
            Console.WriteLine("\nTerrain types (9x9 grid):");
            for (int vy = 8; vy >= 0; vy--)
            {
                for (int vx = 0; vx < 9; vx++)
                {
                    int idx = vx * 9 + vy;
                    Console.Write($"{terrainTypes[idx]:2d} ");
                }
                Console.WriteLine($"  vy={vy}");
            }
            Console.WriteLine("vx: 0  1  2  3  4  5  6  7  8");
            
            // Find all unique terrain types
            var uniqueTypes = terrainTypes.Distinct().OrderBy(x => x).ToList();
            Console.WriteLine($"\nUnique terrain types in this landblock: {string.Join(", ", uniqueTypes)}");
            
            // Check for water codes (16-20)
            var waterCodes = terrainTypes.Where(t => t >= 16 && t <= 20).ToList();
            Console.WriteLine($"Water vertices (codes 16-20): {waterCodes.Count}");
            if (waterCodes.Count > 0)
                Console.WriteLine($"Water types found: {string.Join(", ", waterCodes.Distinct().OrderBy(x => x))}");
            
            Console.WriteLine("\n=== CELL (4,6) - CORNER DETAILS ===");
            int[] cell46Corners = { 4*9+6, 5*9+6, 4*9+7, 5*9+7 };
            int water46 = 0;
            for (int i = 0; i < 4; i++)
            {
                int idx = cell46Corners[i];
                int vx = idx / 9;
                int vy = idx % 9;
                int code = terrainTypes[idx];
                bool isWater = code >= 16 && code <= 20;
                if (isWater) water46++;
                ushort rawTerrain = cellLb.Terrain[idx];
                Console.WriteLine($"  Vertex ({vx},{vy}): idx={idx} raw=0x{rawTerrain:X4} type={code} water={isWater}");
            }
            string class46 = water46 == 4 ? "EntirelyWater" : (water46 > 0 ? "PartiallyWater" : "NotWater");
            Console.WriteLine($"  Cell (4,6) classification: {class46} ({water46}/4 corners)");
            
            Console.WriteLine("\n=== CELL (4,7) - CORNER DETAILS ===");
            int[] cell47Corners = { 4*9+7, 5*9+7, 4*9+8, 5*9+8 };
            int water47 = 0;
            for (int i = 0; i < 4; i++)
            {
                int idx = cell47Corners[i];
                int vx = idx / 9;
                int vy = idx % 9;
                int code = terrainTypes[idx];
                bool isWater = code >= 16 && code <= 20;
                if (isWater) water47++;
                ushort rawTerrain = cellLb.Terrain[idx];
                Console.WriteLine($"  Vertex ({vx},{vy}): idx={idx} raw=0x{rawTerrain:X4} type={code} water={isWater}");
            }
            string class47 = water47 == 4 ? "EntirelyWater" : (water47 > 0 ? "PartiallyWater" : "NotWater");
            Console.WriteLine($"  Cell (4,7) classification: {class47} ({water47}/4 corners)");
            
            // Check the column vx=4 and vx=5
            Console.WriteLine("\n=== COLUMN ANALYSIS (vx=4,5) ===");
            Console.WriteLine("vx=4:");
            for (int vy = 0; vy < 9; vy++)
            {
                int idx = 4*9+vy;
                int code = terrainTypes[idx];
                ushort rawTerrain = cellLb.Terrain[idx];
                bool isWater = code >= 16 && code <= 20;
                Console.WriteLine($"  ({4},{vy}): idx={idx} raw=0x{rawTerrain:X4} type={code} water={isWater}");
            }
            
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Error: {ex.Message}");
            Console.Error.WriteLine(ex.StackTrace);
            return 1;
        }
    }
}
