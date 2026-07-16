// vendored from /mnt/wbterminal1/ac-refs/rynthsuite/Tools/RynthNav.PortalGraph/PortalRoute.cs @ bf1fb52 on 2026-07-16; upstream is read-only reference
using System;
using System.Collections.Generic;

namespace RynthNav.Routing;

// Shared, dependency-free travel-route planner. Compiled into BOTH the offline
// RynthNav.PortalGraph tool (for validation) and the in-process RynthNav plugin
// (the code that actually ships), so what we test offline is exactly what runs.
//
// Coordinates everywhere are AC /loc decimal degrees (NS, EW). Distances are in
// world units (1 /loc degree = 240 units). The planner runs a uniform-cost
// (Dijkstra) search over a graph of portal endpoints + START + GOAL and returns
// an ordered list of walk legs, each optionally ending in "use a portal".

/// <summary>One directed portal: walk to (SrcNs,SrcEw), teleport, arrive (DstNs,DstEw).</summary>
public readonly struct PortalLink
{
    public readonly double SrcNs, SrcEw, DstNs, DstEw;
    public readonly string Name;
    public PortalLink(double srcNs, double srcEw, double dstNs, double dstEw, string name)
    { SrcNs = srcNs; SrcEw = srcEw; DstNs = dstNs; DstEw = dstEw; Name = name; }
}

/// <summary>A recall spell: usable from anywhere, lands at a fixed spot.</summary>
public readonly struct RecallLink
{
    public readonly double DstNs, DstEw;
    public readonly string Name;
    public RecallLink(double dstNs, double dstEw, string name) { DstNs = dstNs; DstEw = dstEw; Name = name; }
}

/// <summary>One leg of a route: walk to (Ns,Ew); if UsePortal, trigger the portal on arrival.</summary>
public readonly struct RouteStep
{
    public readonly double Ns, Ew;
    public readonly bool UsePortal;   // arriving here, walk into the portal and wait for teleport
    public readonly bool UseRecall;   // cast a recall here instead of walking into a portal
    public readonly string Label;
    public RouteStep(double ns, double ew, bool usePortal, bool useRecall, string label)
    { Ns = ns; Ew = ew; UsePortal = usePortal; UseRecall = useRecall; Label = label; }
}

public static class PortalRoute
{
    public const double UnitsPerDegree = 240.0;

    // Tuning. A portal/recall "costs" this many world units of equivalent effort,
    // so the planner only takes one when it saves more walking than the penalty.
    public const double PortalPenaltyUnits = 360.0;   // ~1.5 deg
    public const double RecallPenaltyUnits = 1200.0;  // recalls are slow to cast; ~5 deg
    // Only chain one portal's exit to another portal's entrance if they're within
    // this far apart (same town/area). START->any-portal and any-portal->GOAL are
    // always allowed so the graph can't disconnect.
    public const double ChainWalkRadiusUnits = 4000.0; // ~16.7 deg

    private static double Dist(double aNs, double aEw, double bNs, double bEw)
    {
        double dn = (aNs - bNs) * UnitsPerDegree, de = (aEw - bEw) * UnitsPerDegree;
        return Math.Sqrt(dn * dn + de * de);
    }

    private enum EdgeKind { Walk, Portal, Recall }
    private readonly struct Edge { public readonly int To; public readonly double Cost; public readonly EdgeKind Kind; public readonly string Label;
        public Edge(int to, double cost, EdgeKind kind, string label) { To = to; Cost = cost; Kind = kind; Label = label; } }

    /// <summary>
    /// Plan a route from start to goal. Returns the ordered walk legs. The first leg(s)
    /// may be portal/recall hops; the final leg is always a plain walk to the goal.
    /// estUnits = total estimated cost; portalsUsed = how many teleports the plan takes.
    /// </summary>
    public static List<RouteStep> Plan(
        IReadOnlyList<PortalLink> portals,
        IReadOnlyList<RecallLink>? recalls,
        double startNs, double startEw,
        double goalNs, double goalEw,
        out double estUnits, out int portalsUsed)
    {
        recalls ??= Array.Empty<RecallLink>();

        // Node layout: 0=START, 1=GOAL, then per-portal [Src,Dst] pairs, then recall dsts.
        int n = 2 + portals.Count * 2 + recalls.Count;
        var ns = new double[n];
        var ew = new double[n];
        ns[0] = startNs; ew[0] = startEw;
        ns[1] = goalNs; ew[1] = goalEw;
        for (int i = 0; i < portals.Count; i++)
        {
            int s = 2 + i * 2, d = s + 1;
            ns[s] = portals[i].SrcNs; ew[s] = portals[i].SrcEw;
            ns[d] = portals[i].DstNs; ew[d] = portals[i].DstEw;
        }
        int recallBase = 2 + portals.Count * 2;
        for (int i = 0; i < recalls.Count; i++) { ns[recallBase + i] = recalls[i].DstNs; ew[recallBase + i] = recalls[i].DstEw; }

        var adj = new List<Edge>[n];
        for (int i = 0; i < n; i++) adj[i] = new List<Edge>();

        // Direct walk fallback START -> GOAL.
        adj[0].Add(new Edge(1, Dist(startNs, startEw, goalNs, goalEw), EdgeKind.Walk, "walk"));

        for (int i = 0; i < portals.Count; i++)
        {
            int s = 2 + i * 2, d = s + 1;
            string name = portals[i].Name;
            // The teleport itself.
            adj[s].Add(new Edge(d, PortalPenaltyUnits, EdgeKind.Portal, name));
            // Walk from START to this portal entrance, and from this portal exit to GOAL.
            adj[0].Add(new Edge(s, Dist(startNs, startEw, ns[s], ew[s]), EdgeKind.Walk, "walk"));
            adj[d].Add(new Edge(1, Dist(ns[d], ew[d], goalNs, goalEw), EdgeKind.Walk, "walk"));
        }

        // Chain portals: walk from one exit to a nearby other entrance.
        for (int i = 0; i < portals.Count; i++)
        {
            int di = 3 + i * 2;
            for (int j = 0; j < portals.Count; j++)
            {
                if (i == j) continue;
                int sj = 2 + j * 2;
                double w = Dist(ns[di], ew[di], ns[sj], ew[sj]);
                if (w <= ChainWalkRadiusUnits) adj[di].Add(new Edge(sj, w, EdgeKind.Walk, "walk"));
            }
        }

        // Recalls: from START (anywhere) to a fixed landing, then walk/chain like an exit.
        for (int i = 0; i < recalls.Count; i++)
        {
            int r = recallBase + i;
            adj[0].Add(new Edge(r, RecallPenaltyUnits, EdgeKind.Recall, recalls[i].Name));
            adj[r].Add(new Edge(1, Dist(ns[r], ew[r], goalNs, goalEw), EdgeKind.Walk, "walk"));
            for (int j = 0; j < portals.Count; j++)
            {
                int sj = 2 + j * 2;
                double w = Dist(ns[r], ew[r], ns[sj], ew[sj]);
                if (w <= ChainWalkRadiusUnits) adj[r].Add(new Edge(sj, w, EdgeKind.Walk, "walk"));
            }
        }

        // Dijkstra (uniform-cost; optimal with positive edge costs).
        var dist = new double[n];
        var prev = new int[n];
        var prevKind = new EdgeKind[n];
        var prevLabel = new string[n];
        var done = new bool[n];
        for (int i = 0; i < n; i++) { dist[i] = double.PositiveInfinity; prev[i] = -1; }
        dist[0] = 0;
        var pq = new SortedSet<(double cost, int node)>();
        pq.Add((0, 0));
        while (pq.Count > 0)
        {
            var (cu, u) = pq.Min; pq.Remove(pq.Min);
            if (done[u]) continue;
            done[u] = true;
            if (u == 1) break;
            foreach (var e in adj[u])
            {
                if (done[e.To]) continue;
                double nd = cu + e.Cost;
                if (nd < dist[e.To])
                {
                    if (!double.IsPositiveInfinity(dist[e.To])) pq.Remove((dist[e.To], e.To));
                    dist[e.To] = nd; prev[e.To] = u; prevKind[e.To] = e.Kind; prevLabel[e.To] = e.Label;
                    pq.Add((nd, e.To));
                }
            }
        }

        estUnits = dist[1];
        portalsUsed = 0;
        var steps = new List<RouteStep>();
        if (double.IsPositiveInfinity(dist[1])) return steps; // unreachable (shouldn't happen — direct walk always exists)

        // Rebuild node path START..GOAL.
        var nodes = new List<int>();
        for (int v = 1; v != -1; v = prev[v]) nodes.Add(v);
        nodes.Reverse();

        // Convert node hops into walk legs, folding portal/recall edges into the
        // preceding walk leg's "use on arrival" flag.
        for (int k = 1; k < nodes.Count; k++)
        {
            int to = nodes[k];
            EdgeKind kind = prevKind[to];
            if (kind == EdgeKind.Walk)
            {
                steps.Add(new RouteStep(ns[to], ew[to], false, false, prevLabel[to]));
            }
            else if (kind == EdgeKind.Portal)
            {
                portalsUsed++;
                // 'to' is a portal Dst reached by teleport; the entrance is the prior node,
                // which the previous walk leg already targets. Flag that leg as a portal use.
                if (steps.Count > 0)
                    steps[steps.Count - 1] = new RouteStep(steps[^1].Ns, steps[^1].Ew, true, false, prevLabel[to]);
            }
            else // Recall
            {
                portalsUsed++;
                // Recall is cast from START (current position); insert a recall step at START.
                steps.Add(new RouteStep(startNs, startEw, false, true, prevLabel[to]));
            }
        }
        return steps;
    }
}
