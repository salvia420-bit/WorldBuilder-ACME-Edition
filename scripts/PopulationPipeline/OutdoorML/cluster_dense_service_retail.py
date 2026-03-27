#!/usr/bin/env python3
"""
cluster_dense_service_retail.py - Cluster retail dense service landblocks
=========================================================================

Derive compact, data-driven dense-service composition clusters from the retail
benchmark dataset. This avoids hard-coding another supervision taxonomy before
we've looked at how retail dense service blocks actually group.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from collections import Counter, defaultdict

import numpy as np


BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
REFERENCE_DIR = os.path.join(BASE_DIR, "pipeline_data", "reference")
DEFAULT_JSON_IN = os.path.join(REFERENCE_DIR, "dense_service_retail_dataset.json")
DEFAULT_NPZ_IN = os.path.join(REFERENCE_DIR, "dense_service_retail_dataset.npz")
DEFAULT_JSON_OUT = os.path.join(REFERENCE_DIR, "dense_service_retail_clusters.json")
DEFAULT_NPZ_OUT = os.path.join(REFERENCE_DIR, "dense_service_retail_clusters.npz")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Cluster retail dense-service benchmark landblocks")
    parser.add_argument("--json-in", default=DEFAULT_JSON_IN, help="Input dense-service JSON dataset")
    parser.add_argument("--npz-in", default=DEFAULT_NPZ_IN, help="Input dense-service NPZ dataset")
    parser.add_argument("--json-out", default=DEFAULT_JSON_OUT, help="Output cluster JSON summary")
    parser.add_argument("--npz-out", default=DEFAULT_NPZ_OUT, help="Output cluster NPZ labels")
    parser.add_argument("--clusters", type=int, default=4, help="Number of clusters to fit")
    parser.add_argument("--iterations", type=int, default=50, help="Maximum k-means iterations")
    return parser.parse_args()


def zscore_features(features: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    mean = features.mean(axis=0)
    std = features.std(axis=0)
    std = np.where(std < 1e-6, 1.0, std)
    return (features - mean) / std, mean, std


def kmeans(features: np.ndarray, k: int, iterations: int) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(42)
    centroids = features[rng.choice(len(features), size=k, replace=False)].copy()
    labels = np.zeros(len(features), dtype=np.int64)

    for _ in range(iterations):
        distances = ((features[:, None, :] - centroids[None, :, :]) ** 2).sum(axis=2)
        new_labels = distances.argmin(axis=1)
        if np.array_equal(new_labels, labels):
            break
        labels = new_labels
        for idx in range(k):
            members = features[labels == idx]
            if len(members) == 0:
                centroids[idx] = features[rng.integers(0, len(features))]
            else:
                centroids[idx] = members.mean(axis=0)
    return labels, centroids


def summarize_clusters(rows: list[dict], labels: np.ndarray, feature_labels: list[str], raw_features: np.ndarray) -> list[dict]:
    clusters: list[dict] = []
    k = int(labels.max()) + 1 if len(labels) else 0
    for cluster_id in range(k):
        member_indices = np.where(labels == cluster_id)[0]
        cluster_rows = [rows[int(i)] for i in member_indices]
        cluster_features = raw_features[member_indices]

        signature_counts = Counter(row["settlement_signature"] for row in cluster_rows)
        service_style_counts = Counter(row["service_style"] for row in cluster_rows)
        avg_features = cluster_features.mean(axis=0) if len(cluster_features) else np.zeros(raw_features.shape[1])
        exemplar_idx = int(member_indices[0]) if len(member_indices) else -1
        if len(cluster_features):
            centroid = avg_features
            distances = ((cluster_features - centroid[None, :]) ** 2).sum(axis=1)
            exemplar_idx = int(member_indices[int(distances.argmin())])

        clusters.append(
            {
                "cluster_id": cluster_id,
                "count": int(len(member_indices)),
                "top_settlement_signatures": signature_counts.most_common(5),
                "top_service_styles": service_style_counts.most_common(5),
                "avg_features": {
                    label: float(value) for label, value in zip(feature_labels, avg_features.tolist())
                },
                "example_landblocks": [
                    {"lb_x": row["lb_x"], "lb_y": row["lb_y"], "signature": row["settlement_signature"]}
                    for row in cluster_rows[:5]
                ],
                "exemplar_landblock": (
                    {
                        "lb_x": rows[exemplar_idx]["lb_x"],
                        "lb_y": rows[exemplar_idx]["lb_y"],
                        "signature": rows[exemplar_idx]["settlement_signature"],
                        "service_style": rows[exemplar_idx]["service_style"],
                    }
                    if exemplar_idx >= 0 else None
                ),
            }
        )
    clusters.sort(key=lambda row: row["count"], reverse=True)
    return clusters


def main() -> None:
    args = parse_args()
    with open(args.json_in, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    rows = payload["rows"]
    feature_labels = payload["feature_labels"]
    arrays = np.load(args.npz_in)
    raw_features = arrays["features"].astype(np.float32)

    scaled_features, mean, std = zscore_features(raw_features)
    k = min(args.clusters, len(rows))
    labels, centroids = kmeans(scaled_features, k, args.iterations)
    cluster_summaries = summarize_clusters(rows, labels, feature_labels, raw_features)

    os.makedirs(os.path.dirname(args.json_out), exist_ok=True)
    with open(args.json_out, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "source_json": args.json_in,
                "source_npz": args.npz_in,
                "clusters": k,
                "feature_labels": feature_labels,
                "feature_mean": mean.tolist(),
                "feature_std": std.tolist(),
                "cluster_summaries": cluster_summaries,
                "labels": labels.tolist(),
            },
            handle,
            indent=2,
        )

    np.savez_compressed(
        args.npz_out,
        labels=labels.astype(np.int64),
        centroids=centroids.astype(np.float32),
        coords=arrays["coords"].astype(np.int32),
        features=raw_features,
    )

    print("=" * 72)
    print("  Retail Dense-Service Clustering")
    print("=" * 72)
    print(f"  Examples: {len(rows)}")
    print(f"  Clusters: {k}")
    for cluster in cluster_summaries:
        top_sig = cluster["top_settlement_signatures"][0][0] if cluster["top_settlement_signatures"] else "none"
        top_style = cluster["top_service_styles"][0][0] if cluster["top_service_styles"] else "none"
        avg_unique = cluster["avg_features"]["unique_wcids"]
        avg_objects = cluster["avg_features"]["object_count"]
        print(
            f"  Cluster {cluster['cluster_id']}: n={cluster['count']:2d} "
            f"sig={top_sig:<24} style={top_style:<18} "
            f"uniq={avg_unique:5.1f} obj={avg_objects:5.1f}"
        )
    print(f"  JSON: {args.json_out}")
    print(f"  NPZ:  {args.npz_out}")


if __name__ == "__main__":
    main()
