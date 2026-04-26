using System;
using System.Collections.Generic;

namespace WorldBuilder.Shared.Lib.WorldGen {
    public static class RoadGenerator {
        /// <summary>
        /// Generates a road network connecting all towns via minimum spanning tree,
        /// then A* pathfinds each road segment on the vertex grid.
        /// Returns set of (landblock-local lbX, lbY, vertexIndex) that should have Road bits.
        /// </summary>
        public static HashSet<(ushort lbKey, byte vertexIndex)> Generate(
            List<TownSite> towns, float[,] elevation, float seaLevelNorm,
            WorldGeneratorParams p, Random rng) {

            var roadVertices = new HashSet<(ushort, byte)>();
            if (towns.Count < 2) return roadVertices;

            var edges = BuildMST(towns);

            int verticesX = elevation.GetLength(0);
            int verticesY = elevation.GetLength(1);

            foreach (var (a, b) in edges) {
                int ax = (towns[a].CenterLbX - p.StartX) * 8 + 4;
                int ay = (towns[a].CenterLbY - p.StartY) * 8 + 4;
                int bx = (towns[b].CenterLbX - p.StartX) * 8 + 4;
                int by = (towns[b].CenterLbY - p.StartY) * 8 + 4;

                ax = Math.Clamp(ax, 0, verticesX - 1);
                ay = Math.Clamp(ay, 0, verticesY - 1);
                bx = Math.Clamp(bx, 0, verticesX - 1);
                by = Math.Clamp(by, 0, verticesY - 1);

                var path = AStarPath(elevation, seaLevelNorm, ax, ay, bx, by, verticesX, verticesY);
                foreach (var (vx, vy) in path) {
                    AddRoadVertex(roadVertices, vx, vy, p);
                    for (int dx = -1; dx <= 1; dx++) {
                        for (int dy = -1; dy <= 1; dy++) {
                            if (dx == 0 && dy == 0) continue;
                            int nx = vx + dx, ny = vy + dy;
                            if (nx >= 0 && nx < verticesX && ny >= 0 && ny < verticesY)
                                AddRoadVertex(roadVertices, nx, ny, p);
                        }
                    }
                }
            }

            return roadVertices;
        }

        private static void AddRoadVertex(HashSet<(ushort, byte)> set, int vx, int vy, WorldGeneratorParams p) {
            int lbX = vx / 8;
            int lbY = vy / 8;
            int localX = vx % 8;
            int localY = vy % 8;

            int globalLbX = p.StartX + lbX;
            int globalLbY = p.StartY + lbY;
            if (globalLbX < 0 || globalLbX > 254 || globalLbY < 0 || globalLbY > 254) return;

            ushort lbKey = (ushort)((globalLbX << 8) | globalLbY);
            byte vertexIdx = (byte)(localX * 9 + localY);
            if (vertexIdx < 81)
                set.Add((lbKey, vertexIdx));
        }

        /// <summary>Kruskal's MST over town indices.</summary>
        private static List<(int a, int b)> BuildMST(List<TownSite> towns) {
            var edges = new List<(float dist, int a, int b)>();
            for (int i = 0; i < towns.Count; i++) {
                for (int j = i + 1; j < towns.Count; j++) {
                    float dx = towns[i].CenterLbX - towns[j].CenterLbX;
                    float dy = towns[i].CenterLbY - towns[j].CenterLbY;
                    edges.Add((MathF.Sqrt(dx * dx + dy * dy), i, j));
                }
            }
            edges.Sort((a, b) => a.dist.CompareTo(b.dist));

            var parent = new int[towns.Count];
            for (int i = 0; i < parent.Length; i++) parent[i] = i;

            int Find(int x) { while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }

            var mst = new List<(int, int)>();
            foreach (var (_, a, b) in edges) {
                int ra = Find(a), rb = Find(b);
                if (ra != rb) {
                    parent[ra] = rb;
                    mst.Add((a, b));
                    if (mst.Count == towns.Count - 1) break;
                }
            }
            return mst;
        }

        /// <summary>A* pathfinding on the elevation grid with slope-based cost.</summary>
        private static List<(int x, int y)> AStarPath(
            float[,] elevation, float seaLevelNorm,
            int sx, int sy, int gx, int gy, int w, int h) {

            var open = new PriorityQueue<(int x, int y), float>();
            var cameFrom = new Dictionary<(int, int), (int, int)>();
            var gScore = new Dictionary<(int, int), float>();

            var start = (sx, sy);
            var goal = (gx, gy);
            gScore[start] = 0;
            open.Enqueue(start, Heuristic(sx, sy, gx, gy));

            int[] dx = { -1, 0, 1, -1, 1, -1, 0, 1 };
            int[] dy = { -1, -1, -1, 0, 0, 1, 1, 1 };
            float[] dCost = { 1.414f, 1f, 1.414f, 1f, 1f, 1.414f, 1f, 1.414f };

            int maxIter = w * h;
            int iter = 0;

            while (open.Count > 0 && iter++ < maxIter) {
                var current = open.Dequeue();
                if (current == goal) break;

                float curG = gScore.GetValueOrDefault(current, float.MaxValue);

                for (int d = 0; d < 8; d++) {
                    int nx = current.x + dx[d];
                    int ny = current.y + dy[d];
                    if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;

                    float slopeCost = MathF.Abs(elevation[nx, ny] - elevation[current.x, current.y]) * 50f;
                    float waterCost = elevation[nx, ny] < seaLevelNorm ? 100f : 0f;
                    float moveCost = dCost[d] + slopeCost + waterCost;
                    float tentG = curG + moveCost;

                    var neighbor = (nx, ny);
                    if (tentG < gScore.GetValueOrDefault(neighbor, float.MaxValue)) {
                        gScore[neighbor] = tentG;
                        cameFrom[neighbor] = current;
                        open.Enqueue(neighbor, tentG + Heuristic(nx, ny, gx, gy));
                    }
                }
            }

            var path = new List<(int, int)>();
            var pos = goal;
            while (cameFrom.ContainsKey(pos)) {
                path.Add(pos);
                pos = cameFrom[pos];
            }
            path.Add(start);
            path.Reverse();
            return path;
        }

        private static float Heuristic(int ax, int ay, int bx, int by) {
            return MathF.Sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by));
        }
    }
}
