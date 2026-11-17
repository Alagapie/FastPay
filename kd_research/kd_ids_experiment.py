# ============================================================
# KNOWLEDGE DISTILLATION FOR INTRUSION DETECTION  (v2)
# Framework: TensorFlow / Keras
#
# TEACHER:        256 -> 128 -> 64 -> Output  (BatchNorm + Dropout)
# NORMAL STUDENT: 16 -> 8 -> Output           (hard labels only)
# KD STUDENT:     16 -> 8 -> Output           (hard labels + teacher)
#
# What makes the comparison fair:
#   * all three models use the SAME training loop, optimizer,
#     LR schedule, early stopping rule and data order
#   * both students start from the SAME initial weights
#   * the only difference between the students is the loss
#   * temperature / alpha are tuned on VALIDATION data only
#   * everything is repeated over several seeds (mean +/- std)
#
# Run this AFTER your preprocessing. It expects these variables:
#   X_train_scaled, X_val_scaled, X_test_scaled   (2D, scaled)
#   y_train, y_val, y_test                        (integer labels)
#   n_classes, label_encoder
# ============================================================


# ============================================================
# 1. IMPORT LIBRARIES
# ============================================================

import os
import time
import numpy as np
import pandas as pd
import tensorflow as tf
import matplotlib.pyplot as plt
import seaborn as sns

from scipy import stats
from tensorflow.keras import layers, Model

from sklearn.metrics import (
    accuracy_score,
    precision_score,
    recall_score,
    f1_score,
    classification_report,
    confusion_matrix
)

print("TensorFlow version:", tf.__version__)


# ============================================================
# 2. PREPARE DATA
# ============================================================

X_train = np.asarray(X_train_scaled, dtype=np.float32)
X_val = np.asarray(X_val_scaled, dtype=np.float32)
X_test = np.asarray(X_test_scaled, dtype=np.float32)

y_train = np.asarray(y_train, dtype=np.int32).ravel()
y_val = np.asarray(y_val, dtype=np.int32).ravel()
y_test = np.asarray(y_test, dtype=np.int32).ravel()

INPUT_DIM = X_train.shape[1]
NUM_CLASSES = int(n_classes)
CLASS_NAMES = [str(c) for c in label_encoder.classes_]

print("\nDATA INFORMATION")
print("Training samples:", X_train.shape)
print("Validation samples:", X_val.shape)
print("Testing samples:", X_test.shape)
print("Input features:", INPUT_DIM)
print("Number of classes:", NUM_CLASSES)

assert X_train.shape[1] == X_val.shape[1] == X_test.shape[1]
assert np.isfinite(X_train).all(), "X_train contains NaN or inf"
assert np.isfinite(X_val).all(), "X_val contains NaN or inf"
assert np.isfinite(X_test).all(), "X_test contains NaN or inf"
assert len(np.unique(y_train)) == NUM_CLASSES, (
    "A class is missing from y_train. Use a stratified split."
)

class_counts = np.bincount(y_train, minlength=NUM_CLASSES)

print("\nTRAINING CLASS DISTRIBUTION")
for name, count in zip(CLASS_NAMES, class_counts):
    print(f"  {name:<30} {count:>10,}  ({count / len(y_train):.4%})")


# ============================================================
# 3. EXPERIMENTAL CONFIGURATION
# ============================================================

SEEDS = [42, 43, 44, 45, 46]

EPOCHS = 100
BATCH_SIZE = 1024
LEARNING_RATE = 0.001
MIN_LEARNING_RATE = 1e-5
PATIENCE = 10          # early stopping patience (epochs)
LR_PATIENCE = 4        # halve the learning rate after this many bad epochs

TEACHER_UNITS = (256, 128, 64)
TEACHER_DROPOUT = 0.2
STUDENT_UNITS = (16, 8)

# Knowledge distillation search grid (chosen on validation data)
TEMPERATURES = [2.0, 4.0, 6.0]
ALPHAS = [0.5, 0.7, 0.9]

# Class imbalance handling for the hard-label loss of ALL models:
#   "sqrt"     -> weight = 1 / sqrt(class frequency)   (recommended)
#   "balanced" -> weight = 1 / class frequency         (aggressive)
#   None       -> no weighting
CLASS_WEIGHTING = "sqrt"

OUT_DIR = "KD_Experiment"
os.makedirs(OUT_DIR, exist_ok=True)


# ============================================================
# 4. CLASS WEIGHTS
# ============================================================

def compute_class_weights(counts, mode):

    freq = np.maximum(counts, 1) / counts.sum()

    if mode == "balanced":
        w = 1.0 / freq
    elif mode == "sqrt":
        w = 1.0 / np.sqrt(freq)
    else:
        w = np.ones_like(freq)

    # Normalise so the average weight over training samples is 1.
    # This keeps the loss scale (and so the learning rate) unchanged.
    w = w / np.sum(w * freq)

    return w.astype(np.float32)


CLASS_WEIGHTS = compute_class_weights(class_counts, CLASS_WEIGHTING)

print("\nCLASS WEIGHTS:", CLASS_WEIGHTING)
for name, w in zip(CLASS_NAMES, CLASS_WEIGHTS):
    print(f"  {name:<30} {w:.4f}")


# ============================================================
# 5. MODEL BUILDERS
# ============================================================

def build_teacher(input_dim, num_classes):

    inputs = layers.Input(shape=(input_dim,))
    x = inputs

    for units in TEACHER_UNITS:
        x = layers.Dense(units, use_bias=False)(x)
        x = layers.BatchNormalization()(x)
        x = layers.Activation('relu')(x)
        x = layers.Dropout(TEACHER_DROPOUT)(x)

    # Raw logits
    outputs = layers.Dense(num_classes)(x)

    return Model(inputs=inputs, outputs=outputs, name="Teacher_MLP")


def build_student(input_dim, num_classes):

    inputs = layers.Input(shape=(input_dim,))
    x = inputs

    for units in STUDENT_UNITS:
        x = layers.Dense(units, activation='relu')(x)

    # Raw logits
    outputs = layers.Dense(num_classes)(x)

    return Model(inputs=inputs, outputs=outputs, name="Student_MLP")


print("\nTEACHER MODEL")
build_teacher(INPUT_DIM, NUM_CLASSES).summary()

print("\nSTUDENT MODEL (used for both Normal and KD students)")
build_student(INPUT_DIM, NUM_CLASSES).summary()


# ============================================================
# 6. HELPERS: PREDICTION AND VALIDATION
# ============================================================

def predict_logits(model, X, batch_size=8192):

    outputs = []

    for i in range(0, len(X), batch_size):
        outputs.append(
            model(X[i:i + batch_size], training=False).numpy()
        )

    return np.concatenate(outputs, axis=0)


def cross_entropy_np(logits, y):

    z = logits - logits.max(axis=1, keepdims=True)
    log_probs = z - np.log(np.exp(z).sum(axis=1, keepdims=True))

    return float(-log_probs[np.arange(len(y)), y].mean())


def macro_f1(y_true, y_pred):

    return f1_score(
        y_true, y_pred,
        labels=np.arange(NUM_CLASSES),
        average='macro',
        zero_division=0
    )


# ============================================================
# 7. ONE TRAINING LOOP FOR ALL THREE MODELS
# ============================================================
# teacher_logits=None  -> ordinary training on hard labels
# teacher_logits given -> knowledge distillation:
#
#   loss = (1 - alpha) * CE(labels, student)
#          + alpha * T^2 * KL( teacher_T || student_T )
#
# The best checkpoint is chosen by validation macro F1
# (measured against the TRUE labels) for every model.

def train_model(
    model,
    seed,
    teacher_logits=None,
    temperature=1.0,
    alpha=0.0,
    verbose=1
):

    use_kd = teacher_logits is not None
    T = float(temperature)
    a = float(alpha)

    optimizer = tf.keras.optimizers.Adam(learning_rate=LEARNING_RATE)
    optimizer.build(model.trainable_variables)

    class_w = tf.constant(CLASS_WEIGHTS, dtype=tf.float32)

    @tf.function
    def train_step(x_batch, y_batch, t_batch):

        with tf.GradientTape() as tape:

            logits = model(x_batch, training=True)

            # Hard-label loss (class weighted)
            ce = tf.nn.sparse_softmax_cross_entropy_with_logits(
                labels=y_batch,
                logits=logits
            )
            hard_loss = tf.reduce_mean(
                ce * tf.gather(class_w, y_batch)
            )

            if use_kd:

                # Soft-target loss: KL(teacher || student) at temperature T
                t_log_probs = tf.nn.log_softmax(t_batch / T, axis=1)
                s_log_probs = tf.nn.log_softmax(logits / T, axis=1)

                soft_loss = tf.reduce_mean(
                    tf.reduce_sum(
                        tf.exp(t_log_probs) * (t_log_probs - s_log_probs),
                        axis=1
                    )
                )

                total_loss = (
                    (1.0 - a) * hard_loss
                    + a * (T ** 2) * soft_loss
                )

            else:

                soft_loss = tf.constant(0.0)
                total_loss = hard_loss

        gradients = tape.gradient(total_loss, model.trainable_variables)

        optimizer.apply_gradients(
            zip(gradients, model.trainable_variables)
        )

        return tf.stack([total_loss, hard_loss, soft_loss])

    history = {
        'loss': [],
        'hard_loss': [],
        'soft_loss': [],
        'val_loss': [],
        'val_macro_f1': [],
        'val_accuracy': []
    }

    rng = np.random.default_rng(seed)
    n = len(X_train)

    best_score = (-1.0, -np.inf)
    best_weights = model.get_weights()
    wait = 0
    lr_wait = 0
    lr = LEARNING_RATE

    start_time = time.perf_counter()

    for epoch in range(EPOCHS):

        # Full shuffle, identical for every model trained with this seed
        perm = rng.permutation(n)

        sums = tf.zeros(3)
        steps = 0

        for i in range(0, n, BATCH_SIZE):

            idx = perm[i:i + BATCH_SIZE]

            sums += train_step(
                X_train[idx],
                y_train[idx],
                teacher_logits[idx] if use_kd else None
            )
            steps += 1

        train_loss, train_hard, train_soft = (sums / steps).numpy()

        # Validation against the true labels
        val_logits = predict_logits(model, X_val)
        val_pred = val_logits.argmax(axis=1)

        val_loss = cross_entropy_np(val_logits, y_val)
        val_f1 = macro_f1(y_val, val_pred)
        val_acc = accuracy_score(y_val, val_pred)

        history['loss'].append(float(train_loss))
        history['hard_loss'].append(float(train_hard))
        history['soft_loss'].append(float(train_soft))
        history['val_loss'].append(val_loss)
        history['val_macro_f1'].append(val_f1)
        history['val_accuracy'].append(val_acc)

        if verbose:
            print(
                f"  Epoch {epoch + 1:>3}/{EPOCHS} | "
                f"loss {train_loss:.5f} | "
                f"hard {train_hard:.5f} | "
                f"soft {train_soft:.5f} | "
                f"val_loss {val_loss:.5f} | "
                f"val_macroF1 {val_f1:.5f} | "
                f"val_acc {val_acc:.5f} | "
                f"lr {lr:.6f}"
            )

        # Higher macro F1 wins; ties are broken by lower validation loss
        score = (val_f1, -val_loss)

        if score > best_score:

            best_score = score
            best_weights = model.get_weights()
            wait = 0
            lr_wait = 0

        else:

            wait += 1
            lr_wait += 1

            if lr_wait >= LR_PATIENCE and lr > MIN_LEARNING_RATE:

                lr = max(lr * 0.5, MIN_LEARNING_RATE)
                optimizer.learning_rate = lr
                lr_wait = 0

            if wait >= PATIENCE:

                if verbose:
                    print("  Early stopping triggered.")
                break

    model.set_weights(best_weights)

    return {
        'history': history,
        'training_time': time.perf_counter() - start_time,
        'epochs': len(history['loss']),
        'best_val_macro_f1': best_score[0]
    }


# ============================================================
# 8. TEST EVALUATION
# ============================================================

def evaluate_model(y_true, y_pred, model_name, seed):

    return {
        'Seed': seed,
        'Model': model_name,

        'Accuracy': accuracy_score(y_true, y_pred),

        'Macro Precision': precision_score(
            y_true, y_pred, average='macro', zero_division=0
        ),

        'Macro Recall': recall_score(
            y_true, y_pred, average='macro', zero_division=0
        ),

        'Macro F1': macro_f1(y_true, y_pred),

        'Weighted F1': f1_score(
            y_true, y_pred, average='weighted', zero_division=0
        )
    }


MODEL_NAMES = ['Teacher', 'Normal Student', 'KD Student']

results = []
per_class_f1 = {name: [] for name in MODEL_NAMES}
kd_search_rows = []

best_temperature = None
best_alpha = None

first_seed = {}


# ============================================================
# 9. MAIN EXPERIMENT: REPEAT OVER SEEDS
# ============================================================

for seed in SEEDS:

    print("\n" + "=" * 90)
    print(f"SEED {seed}")
    print("=" * 90)

    tf.keras.utils.set_random_seed(seed)

    # --------------------------------------------------------
    # 9.1 Teacher
    # --------------------------------------------------------

    print("\nTRAINING TEACHER...")

    teacher = build_teacher(INPUT_DIM, NUM_CLASSES)
    teacher_run = train_model(teacher, seed)
    teacher.trainable = False

    # The teacher is frozen, so its logits are computed once and reused
    teacher_train_logits = predict_logits(teacher, X_train)

    # --------------------------------------------------------
    # 9.2 Normal student (no distillation)
    # --------------------------------------------------------

    student_init = build_student(INPUT_DIM, NUM_CLASSES).get_weights()

    print("\nTRAINING NORMAL STUDENT...")

    student_normal = build_student(INPUT_DIM, NUM_CLASSES)
    student_normal.set_weights(student_init)
    normal_run = train_model(student_normal, seed)

    # --------------------------------------------------------
    # 9.3 Sanity check: distillation needs a better teacher
    # --------------------------------------------------------

    gap = (
        teacher_run['best_val_macro_f1']
        - normal_run['best_val_macro_f1']
    )

    print(
        f"\nValidation macro F1 -> "
        f"Teacher: {teacher_run['best_val_macro_f1']:.5f} | "
        f"Normal Student: {normal_run['best_val_macro_f1']:.5f} | "
        f"Gap: {gap:+.5f}"
    )

    if gap <= 0:
        print(
            "WARNING: the teacher is NOT better than the normal student "
            "on validation data.\n"
            "         Distillation cannot be expected to help. Make the "
            "student smaller (STUDENT_UNITS)\n"
            "         or improve the teacher before trusting the KD result."
        )

    # --------------------------------------------------------
    # 9.4 Tune temperature and alpha (first seed, validation only)
    # --------------------------------------------------------

    if best_temperature is None:

        print("\nSEARCHING TEMPERATURE AND ALPHA ON VALIDATION DATA...")

        for T in TEMPERATURES:
            for a in ALPHAS:

                candidate = build_student(INPUT_DIM, NUM_CLASSES)
                candidate.set_weights(student_init)

                run = train_model(
                    candidate,
                    seed,
                    teacher_logits=teacher_train_logits,
                    temperature=T,
                    alpha=a,
                    verbose=0
                )

                kd_search_rows.append({
                    'Temperature': T,
                    'Alpha': a,
                    'Val Macro F1': run['best_val_macro_f1'],
                    'Epochs': run['epochs']
                })

                print(
                    f"  T={T:<4} alpha={a:<4} "
                    f"val_macroF1={run['best_val_macro_f1']:.5f}"
                )

        kd_search_df = pd.DataFrame(kd_search_rows)
        kd_search_df.to_csv(
            f"{OUT_DIR}/kd_hyperparameter_search.csv", index=False
        )

        best_row = kd_search_df.loc[kd_search_df['Val Macro F1'].idxmax()]
        best_temperature = float(best_row['Temperature'])
        best_alpha = float(best_row['Alpha'])

        print(
            f"\nSELECTED: temperature={best_temperature}, "
            f"alpha={best_alpha}"
        )

    # --------------------------------------------------------
    # 9.5 KD student (same initial weights as the normal student)
    # --------------------------------------------------------

    print("\nTRAINING KD STUDENT...")

    student_kd = build_student(INPUT_DIM, NUM_CLASSES)
    student_kd.set_weights(student_init)

    kd_run = train_model(
        student_kd,
        seed,
        teacher_logits=teacher_train_logits,
        temperature=best_temperature,
        alpha=best_alpha
    )

    assert student_normal.count_params() == student_kd.count_params()

    # --------------------------------------------------------
    # 9.6 Test evaluation
    # --------------------------------------------------------

    models = {
        'Teacher': teacher,
        'Normal Student': student_normal,
        'KD Student': student_kd
    }

    runs = {
        'Teacher': teacher_run,
        'Normal Student': normal_run,
        'KD Student': kd_run
    }

    predictions = {
        name: predict_logits(model, X_test).argmax(axis=1)
        for name, model in models.items()
    }

    for name in MODEL_NAMES:

        row = evaluate_model(y_test, predictions[name], name, seed)

        # How often the model agrees with the teacher's prediction
        row['Teacher Agreement'] = float(
            np.mean(predictions[name] == predictions['Teacher'])
        )
        row['Training Time (s)'] = runs[name]['training_time']
        row['Epochs'] = runs[name]['epochs']

        results.append(row)

        per_class_f1[name].append(
            f1_score(
                y_test, predictions[name],
                labels=np.arange(NUM_CLASSES),
                average=None,
                zero_division=0
            )
        )

    print("\nTEST RESULTS FOR THIS SEED")
    print(
        pd.DataFrame(results[-3:])
        .drop(columns=['Seed'])
        .to_string(index=False)
    )

    # Keep the first seed's models for reports, plots and efficiency
    if not first_seed:

        first_seed = {
            'models': models,
            'runs': runs,
            'predictions': predictions
        }


# ============================================================
# 10. RESULTS ACROSS SEEDS
# ============================================================

results_df = pd.DataFrame(results)
results_df.to_csv(f"{OUT_DIR}/results_all_seeds.csv", index=False)

metric_cols = [
    'Accuracy',
    'Macro Precision',
    'Macro Recall',
    'Macro F1',
    'Weighted F1',
    'Teacher Agreement'
]

grouped = results_df.groupby('Model')
mean_df = grouped[metric_cols].mean().loc[MODEL_NAMES]
std_df = grouped[metric_cols].std(ddof=1).fillna(0.0).loc[MODEL_NAMES]

summary_df = pd.DataFrame({
    col: [
        f"{mean_df.loc[m, col]:.4f} +/- {std_df.loc[m, col]:.4f}"
        for m in MODEL_NAMES
    ]
    for col in metric_cols
}, index=MODEL_NAMES)

print("\n" + "=" * 110)
print(f"MODEL PERFORMANCE (mean +/- std over {len(SEEDS)} seeds)")
print("=" * 110)
print(summary_df.to_string())

summary_df.to_csv(f"{OUT_DIR}/performance_summary.csv")


# ============================================================
# 11. KD STUDENT vs NORMAL STUDENT (paired by seed)
# ============================================================

pivot = results_df.pivot(index='Seed', columns='Model', values='Macro F1')
difference = pivot['KD Student'] - pivot['Normal Student']

print("\n" + "=" * 110)
print("KD STUDENT vs NORMAL STUDENT  (test macro F1, paired by seed)")
print("=" * 110)

print(pivot[MODEL_NAMES].to_string())

print(f"\nMean improvement from KD: {difference.mean():+.5f}")
print(f"KD student better in {int((difference > 0).sum())} of "
      f"{len(SEEDS)} seeds")

if len(SEEDS) >= 3 and difference.std(ddof=1) > 0:

    t_stat, p_value = stats.ttest_rel(
        pivot['KD Student'], pivot['Normal Student']
    )

    print(f"Paired t-test: t = {t_stat:.3f}, p = {p_value:.4f}")


# ============================================================
# 12. PER-CLASS F1 (mean over seeds)
# ============================================================

per_class_df = pd.DataFrame(
    {name: np.mean(per_class_f1[name], axis=0) for name in MODEL_NAMES},
    index=CLASS_NAMES
)

per_class_df['KD - Normal'] = (
    per_class_df['KD Student'] - per_class_df['Normal Student']
)
per_class_df['Train Samples'] = class_counts

print("\nPER-CLASS F1 (mean over seeds)")
print(per_class_df.to_string(float_format=lambda v: f"{v:.4f}"))

per_class_df.to_csv(f"{OUT_DIR}/per_class_f1.csv")


# ============================================================
# 13. CLASSIFICATION REPORTS AND CONFUSION MATRICES (first seed)
# ============================================================

for name in MODEL_NAMES:

    print("\n" + "=" * 80)
    print(f"{name.upper()}  (seed {SEEDS[0]})")
    print("=" * 80)

    print(
        classification_report(
            y_test,
            first_seed['predictions'][name],
            labels=np.arange(NUM_CLASSES),
            target_names=CLASS_NAMES,
            digits=4,
            zero_division=0
        )
    )

    # Row-normalised: each cell is the share of the actual class
    cm = confusion_matrix(
        y_test,
        first_seed['predictions'][name],
        labels=np.arange(NUM_CLASSES),
        normalize='true'
    )

    plt.figure(figsize=(12, 9))

    sns.heatmap(
        cm,
        annot=True,
        fmt='.2f',
        cmap='Blues',
        vmin=0.0,
        vmax=1.0,
        xticklabels=CLASS_NAMES,
        yticklabels=CLASS_NAMES
    )

    plt.title(f'{name} Confusion Matrix (row-normalised)')
    plt.xlabel('Predicted Class')
    plt.ylabel('Actual Class')
    plt.xticks(rotation=45, ha='right')
    plt.tight_layout()

    filename = name.lower().replace(' ', '_')

    plt.savefig(f'{OUT_DIR}/{filename}_confusion_matrix.png', dpi=300)
    plt.show()
    plt.close()


# ============================================================
# 14. EFFICIENCY: PARAMETERS, SIZE, INFERENCE AND TRAINING TIME
# ============================================================
# Models are saved without optimizer state, so file sizes are
# directly comparable.

def measure_inference_time(model, X, repeats=5):

    forward = tf.function(lambda x: model(x, training=False))

    # Warm-up (also traces both batch shapes)
    for i in range(0, len(X), BATCH_SIZE):
        forward(X[i:i + BATCH_SIZE])

    times = []

    for _ in range(repeats):

        start = time.perf_counter()

        for i in range(0, len(X), BATCH_SIZE):
            forward(X[i:i + BATCH_SIZE]).numpy()

        times.append(time.perf_counter() - start)

    return float(np.median(times))


training_time_mean = grouped['Training Time (s)'].mean()
epochs_mean = grouped['Epochs'].mean()

efficiency_rows = []

for name in MODEL_NAMES:

    model = first_seed['models'][name]
    filename = name.lower().replace(' ', '_')
    path = f"{OUT_DIR}/{filename}.keras"

    model.save(path)

    inference_time = measure_inference_time(model, X_test)

    efficiency_rows.append({
        'Model': name,
        'Parameters': model.count_params(),
        'Weights Size (KB)': model.count_params() * 4 / 1024,
        'File Size (KB)': os.path.getsize(path) / 1024,
        'Inference Time (s)': inference_time,
        'Inference (ms / 1000 samples)':
            inference_time / len(X_test) * 1e6,
        'Mean Training Time (s)': training_time_mean[name],
        'Mean Epochs': epochs_mean[name]
    })

efficiency_df = pd.DataFrame(efficiency_rows).set_index('Model')

teacher_row = efficiency_df.loc['Teacher']

efficiency_df['Compression vs Teacher (x)'] = (
    teacher_row['Parameters'] / efficiency_df['Parameters']
)
efficiency_df['Speed-up vs Teacher (x)'] = (
    teacher_row['Inference Time (s)'] / efficiency_df['Inference Time (s)']
)

print("\n" + "=" * 110)
print("EFFICIENCY COMPARISON")
print("=" * 110)
print(efficiency_df.T.to_string(float_format=lambda v: f"{v:,.4f}"))

efficiency_df.to_csv(f"{OUT_DIR}/efficiency_comparison.csv")


# ============================================================
# 15. FINAL COMPARISON TABLE
# ============================================================

final_results = mean_df.join(efficiency_df)

print("\n" + "=" * 110)
print("FINAL EXPERIMENTAL RESULTS (performance = mean over seeds)")
print("=" * 110)
print(final_results.T.to_string(float_format=lambda v: f"{v:,.4f}"))

final_results.to_csv(f"{OUT_DIR}/final_comparison.csv")


# ============================================================
# 16. PERFORMANCE COMPARISON GRAPH (mean +/- std)
# ============================================================

plot_metrics = ['Accuracy', 'Macro Precision', 'Macro Recall', 'Macro F1']

mean_df[plot_metrics].T.plot(
    kind='bar',
    yerr=std_df[plot_metrics].T,
    capsize=4,
    figsize=(12, 6),
    width=0.75
)

plt.title(
    f'Teacher vs Normal Student vs KD Student '
    f'(mean +/- std, {len(SEEDS)} seeds)'
)
plt.xlabel('Metric')
plt.ylabel('Score')

lowest = float((mean_df[plot_metrics] - std_df[plot_metrics]).min().min())
plt.ylim(max(0.0, lowest - 0.05), 1.005)

plt.xticks(rotation=0)
plt.grid(axis='y', alpha=0.3)
plt.legend(loc='lower right')
plt.tight_layout()

plt.savefig(f'{OUT_DIR}/performance_comparison.png', dpi=300)
plt.show()
plt.close()


# ============================================================
# 17. PER-CLASS F1 GRAPH
# ============================================================

per_class_df[MODEL_NAMES].plot(
    kind='bar',
    figsize=(14, 6),
    width=0.8
)

plt.title('Per-Class F1 (mean over seeds)')
plt.xlabel('Class')
plt.ylabel('F1 Score')
plt.ylim(0, 1.05)
plt.xticks(rotation=45, ha='right')
plt.grid(axis='y', alpha=0.3)
plt.legend(loc='lower right')
plt.tight_layout()

plt.savefig(f'{OUT_DIR}/per_class_f1.png', dpi=300)
plt.show()
plt.close()


# ============================================================
# 18. TRAINING CURVES (first seed)
# ============================================================
# Both panels use quantities measured against the TRUE labels,
# so the three models are on the same scale.

fig, axes = plt.subplots(1, 2, figsize=(15, 5.5))

for name in MODEL_NAMES:

    history = first_seed['runs'][name]['history']
    epochs_axis = np.arange(1, len(history['val_loss']) + 1)

    axes[0].plot(epochs_axis, history['val_loss'], label=name)
    axes[1].plot(epochs_axis, history['val_macro_f1'], label=name)

axes[0].set_title('Validation Cross-Entropy Loss')
axes[0].set_xlabel('Epoch')
axes[0].set_ylabel('Loss')

axes[1].set_title('Validation Macro F1')
axes[1].set_xlabel('Epoch')
axes[1].set_ylabel('Macro F1')

for ax in axes:
    ax.grid(alpha=0.3)
    ax.legend()

plt.tight_layout()

plt.savefig(f'{OUT_DIR}/training_curves.png', dpi=300)
plt.show()
plt.close()


# ============================================================
# 19. DONE
# ============================================================

print("\nEXPERIMENT SETTINGS")
print("Seeds:", SEEDS)
print("Class weighting:", CLASS_WEIGHTING)
print("Selected temperature:", best_temperature)
print("Selected alpha:", best_alpha)
print("Student parameters:", first_seed['models']['KD Student'].count_params())
print("Teacher parameters:", first_seed['models']['Teacher'].count_params())

print("\nALL EXPERIMENTS COMPLETED SUCCESSFULLY.")
print(f"Results saved in {OUT_DIR}/")
