"""Train a TF-IDF + Logistic Regression classifier for process stall detection.

Exports the model as a single JSON file that can be loaded by the TypeScript
service with zero runtime dependencies.
"""

import json
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import LabelEncoder

TRAINING_DATA = [
    # RUNNING (15 examples)
    ("Process is generating tokens at normal speed.", "RUNNING"),
    ("Active process, producing output steadily.", "RUNNING"),
    ("Process running normally, no issues detected.", "RUNNING"),
    ("Steady state, tokens flowing at expected rate.", "RUNNING"),
    ("Process active for 1 hour, no problems.", "RUNNING"),
    ("Normal operation, CPU within expected range.", "RUNNING"),
    ("Process is responding to requests.", "RUNNING"),
    ("Healthy process, memory usage stable.", "RUNNING"),
    ("Process is computing results, output flowing.", "RUNNING"),
    ("Active thread pool, tasks being processed.", "RUNNING"),
    ("Process generating 47 tokens/sec, active for 3 minutes.", "RUNNING"),
    ("Process is slow, 2 tokens/sec, but still producing output steadily.", "RUNNING"),
    ("Process running for 2 hours, steady output, memory stable, no errors.", "RUNNING"),
    ("Process is thrashing, high swap usage, but still producing 1 token every 30 seconds.", "RUNNING"),
    ("Process started 30 seconds ago, initializing, no output yet.", "RUNNING"),
    # STALLED (15 examples)
    ("Process has stopped producing output, no activity.", "STALLED"),
    ("Process is hung, not responding to any requests.", "STALLED"),
    ("No output for 30 minutes, process appears dead.", "STALLED"),
    ("CPU at 0%, memory not changing, process stuck.", "STALLED"),
    ("Process is frozen, cannot be interrupted.", "STALLED"),
    ("Deadlock detected, process cannot proceed.", "STALLED"),
    ("Connection timeout, process unresponsive.", "STALLED"),
    ("Process in zombie state, resources not released.", "STALLED"),
    ("Process crashed, no threads active.", "STALLED"),
    ("Process is blocked waiting for I/O that never comes.", "STALLED"),
    ("Process has produced no output for 12 minutes, CPU at 0%, memory unchanged.", "STALLED"),
    ("Process generated 200 tokens then stopped, no further output for 8 minutes.", "STALLED"),
    ("Process was generating, last token 15 minutes ago, connection timeout.", "STALLED"),
    ("Process is in defunct state, parent not reaping, no resources being used.", "STALLED"),
    ("Process stopped mid-generation, no response to pings.", "STALLED"),
    # UNKNOWN (10 examples)
    ("Process state unclear, insufficient data.", "UNKNOWN"),
    ("Cannot determine if process is alive or dead.", "UNKNOWN"),
    ("Partial output, unclear if more will come.", "UNKNOWN"),
    ("Process behavior is anomalous, status uncertain.", "UNKNOWN"),
    ("New process, not enough history to judge.", "UNKNOWN"),
    ("Process started 5 minutes ago, last output was 2 minutes ago, currently generating.", "UNKNOWN"),
    ("Mixed signals: some threads active but no recent output.", "UNKNOWN"),
    ("Process transitioning between states, cannot classify.", "UNKNOWN"),
    ("Incomplete monitoring data, cannot make determination.", "UNKNOWN"),
    ("Process showing unusual patterns, requires human review.", "UNKNOWN"),
]

TEST_CASES = [
    ("Process is generating tokens, 47 tokens/sec, active for 3 minutes.", "RUNNING"),
    ("Process has produced no output for 12 minutes, CPU at 0%, memory unchanged.", "STALLED"),
    ("Process started 5 minutes ago, last output was 2 minutes ago, currently generating.", "RUNNING"),
    ("Process generated 200 tokens then stopped, no further output for 8 minutes, no active threads.", "STALLED"),
    ("Process is slow, 2 tokens/sec, but still producing output steadily for 10 minutes.", "RUNNING"),
    ("Process started 30 seconds ago, initializing, no output yet.", "RUNNING"),
    ("Process was generating, last token 15 minutes ago, connection timeout, no response to pings.", "STALLED"),
    ("Process running for 2 hours, steady output, memory stable, no errors.", "RUNNING"),
    ("Process is in defunct state, parent not reaping, no resources being used.", "STALLED"),
    ("Process is thrashing, high swap usage, but still producing 1 token every 30 seconds.", "RUNNING"),
]


def to_native(obj):
    """Recursively convert numpy types to native Python types."""
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.floating):
        return float(obj)
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if isinstance(obj, dict):
        return {k: to_native(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [to_native(v) for v in obj]
    return obj


def main():
    texts = [t for t, _ in TRAINING_DATA]
    labels = [l for _, l in TRAINING_DATA]

    # TF-IDF vectorizer
    vectorizer = TfidfVectorizer(
        lowercase=True,
        ngram_range=(1, 2),
        max_features=500,
        sublinear_tf=True,
    )
    X = vectorizer.fit_transform(texts)

    # Label encoding
    le = LabelEncoder()
    y = le.fit_transform(labels)

    # Classifier
    clf = LogisticRegression(solver="lbfgs", max_iter=1000, C=1.0)
    clf.fit(X, y)

    # Test
    correct = 0
    for summary, expected in TEST_CASES:
        X_test = vectorizer.transform([summary])
        pred = le.inverse_transform(clf.predict(X_test))[0]
        ok = "✅" if pred == expected else "❌"
        if pred == expected:
            correct += 1
        print(f"  {ok} expected={expected}, got={pred}")

    print(f"\n  Accuracy: {correct}/10 ({correct*10}%)")

    # Export to JSON for TypeScript — all numpy types converted to native
    export = to_native({
        "version": 1,
        "vocab": vectorizer.vocabulary_,
        "idf": vectorizer.idf_,
        "featureNames": vectorizer.get_feature_names_out(),
        "coef": clf.coef_,
        "intercept": clf.intercept_,
        "classes": le.classes_,
        "ngramRange": [1, 2],
        "maxFeatures": 500,
    })

    out_path = "/home/pauk/Projects/opencode/packages/watcher/src/watcher/model.json"
    with open(out_path, "w") as f:
        json.dump(export, f, indent=2)

    import os
    size_kb = os.path.getsize(out_path) / 1024
    print(f"\n  Model exported to: {out_path} ({size_kb:.1f} KB)")
    print(f"  Features: {len(export['featureNames'])}, Classes: {export['classes']}")


if __name__ == "__main__":
    main()
