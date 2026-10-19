<template>
  <UDashboardPanel id="gate" :ui="{ body: 'p-0 sm:p-0 overscroll-none' }">
    <template #header>
      <UDashboardNavbar :title="label" :icon="GATE_ICON">
        <!-- What belongs to this gate alone stands beside its name; the right end keeps what every
             screen carries. -->
        <template #trailing>
          <div class="flex min-w-0 items-center gap-2">
            <!-- The gate's Laya mode and how often Laya agrees with it, which lead to where the mode
                 is set: this gate's settings. -->
            <UButton
              v-if="layaLine !== ''"
              class="hidden min-w-0 tabular-nums sm:inline-flex"
              size="sm"
              color="neutral"
              variant="ghost"
              :label="layaLine"
              :aria-label="layaName"
              @click="settingsOpen = true"
            />

            <UTooltip :text="$t('gates.action.view_log')">
              <UButton
                :to="`/agents/${stage}`"
                size="sm"
                color="neutral"
                variant="ghost"
                icon="i-material-symbols-description-outline"
                :aria-label="$t('gates.action.view_log')"
              />
            </UTooltip>

            <!-- This gate's own row of the agent management screen's gate table, the host's dialog. -->
            <UTooltip :text="$t('gates.action.settings')">
              <UButton size="sm" color="neutral" variant="ghost" icon="i-material-symbols-settings-outline" :aria-label="$t('gates.action.settings')" @click="settingsOpen = true" />
            </UTooltip>
          </div>
        </template>

        <template #right>
          <DeployMark />
          <TodoOpenButton />
          <UsageMeters />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UContainer ref="feed" class="flex-1 flex flex-col gap-4 sm:gap-6 py-4 sm:py-6">
        <ContentSkeleton v-if="pending && trials.length === 0" :rows="4" listClass="flex flex-col gap-4 sm:gap-6" :label="$t('gates.status.records_loading')">
          <div class="w-4/5 max-w-lg space-y-2 rounded-lg bg-elevated/40 p-3 even:self-end">
            <SkeletonLine width="w-24" />
            <SkeletonText :lines="2" size="sm" lastWidth="w-2/3" />
          </div>
        </ContentSkeleton>
        <div v-else-if="historyError" class="flex flex-col items-center gap-2 text-sm text-muted">
          <p>{{ historyError }}</p>
          <UButton size="sm" color="neutral" variant="soft" :label="$t('gates.action.read_again')" :loading="pending" @click="loadHistory()" />
        </div>
        <p v-if="!pending && !historyError && trials.length === 0" class="text-center text-sm text-muted">
          {{ $t("gates.status.no_trials") }}
        </p>

        <!-- The scroll-to-bottom button is placed for a prompt that sits inside the scrolling
             area; this one sits under it, so the button sticks to the foot of the scroll
             instead of floating a fixed share of the panel down. -->
        <UChatMessages
          :should-scroll-to-bottom="false"
          :ui="{ root: 'px-0', viewport: 'sticky top-auto bottom-2 h-0' }"
        >
          <template v-for="trial in trials" :key="trial.id">
            <UChatMessage :id="`q${trial.id}`" role="user" side="right" variant="soft" :parts="[]">
              <template #header>
                <span class="text-sm text-muted">{{ trial.user }} · {{ formatClock(trial.created_at) }}</span>
              </template>

              <template #content>
                <p class="whitespace-pre-wrap">{{ trial.prompt }}</p>
              </template>
            </UChatMessage>

            <UChatMessage
              :id="`a${trial.id}`"
              role="assistant"
              side="left"
              variant="naked"
              :avatar="{ icon: GATE_ICON }"
              :parts="[]"
            >
              <template #header>
                <span class="text-sm text-muted">{{ label }} · {{ formatDuration(trial.ms) }}</span>
              </template>

              <template #content>
                <MarkdownText v-if="trial.answer" :text="trial.answer" class="text-sm" />
                <p v-else class="text-muted italic">{{ $t("gates.status.no_answer") }}</p>
              </template>

              <template #actions>
                <UTooltip :text="$t('common.action.copy')">
                  <UButton
                    size="sm"
                    color="neutral"
                    variant="ghost"
                    icon="i-material-symbols-content-copy-outline"
                    :aria-label="$t('gates.action.copy_answer')"
                    @click="copyAnswer(trial)"
                  />
                </UTooltip>
              </template>
            </UChatMessage>
          </template>

          <UChatMessage
            v-if="sending"
            id="waiting"
            role="assistant"
            side="left"
            variant="naked"
            :avatar="{ icon: GATE_ICON }"
            :parts="[]"
          >
            <template #content>
              <UChatShimmer :text="$t('gates.status.judging')" />
            </template>
          </UChatMessage>
        </UChatMessages>
      </UContainer>

      <GateSettingsDialog v-model:open="settingsOpen" :gate="stage" />
    </template>

    <template #footer>
      <div class="border-t border-default py-4">
        <UContainer>
          <UChatPrompt
            v-model="input"
            @keydown.capture="enter.keydown"
            @compositionend.capture="enter.compositionend"
            :submit-on-enter="submitOnEnter"
            :placeholder="$t('gates.label.message')"
            :disabled="sending"
            color="neutral"
            variant="subtle"
            @submit="ask"
          >
            <template #footer>
              <UChatPromptSubmit class="ms-auto" :status="sending ? 'submitted' : 'ready'" color="neutral" />
            </template>
          </UChatPrompt>
        </UContainer>
      </div>
    </template>
  </UDashboardPanel>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";

import { useIsland } from "bmo-ui/app/domain/island";
import { usePromptEnter } from "bmo-ui/app/domain/prompt";
import { formatClock } from "bmo-ui/app/domain/time";

import { agreementText, GATE_ICON, gateLabel, layaModeLabel, refusalText } from "../../domain/gates";

import type { LayaView, Trial } from "../../../shared/gate";

// Another gate is another screen.
definePageMeta({ key: (route) => route.path });

const feedRef = useTemplateRef<{ $el?: HTMLElement }>("feed");

const route = useRoute();
const { t, te } = useI18n();
const island = useIsland(t);
const has = (key: string): boolean => te(key);

const stage = String(route.params.stage);
const label = computed<string>(() => gateLabel(t, has, stage));

const trials = ref<Trial[]>([]);
const input = ref("");
const { submitOnEnter, enter } = usePromptEnter(() => void ask());
const pending = ref(true);
const historyError = ref("");
const sending = ref(false);
const settingsOpen = ref(false);

// This gate's Laya mode and agreement, where Laya is asked on it (the gate's docs/laya.md). Both are read from
// the gate; the mode is set only in the settings the line opens.
const laya = ref<LayaView | null>(null);

const layaGate = computed(() => laya.value?.gates.find((gate) => gate.stage === stage) ?? null);

// The title bar has little room, so the line is the mode and the figure; its name says what the figure is.
const layaLine = computed<string>(() => {
  const gate = layaGate.value;

  return gate === null ? "" : `Laya ${layaModeLabel(t, has, gate.mode)} ${agreementText(gate.agreement?.agreement)}`;
});

const layaName = computed<string>(() => {
  const gate = layaGate.value;

  return gate === null
    ? ""
    : t("gates.aria.laya_settings", { mode: layaModeLabel(t, has, gate.mode), agreement: agreementText(gate.agreement?.agreement) });
});

function formatDuration(ms: number): string {
  return t("common.label.seconds", { n: (ms / 1000).toFixed(1) });
}

async function scrollToBottom(): Promise<void> {
  await nextTick();

  // The panel scrolls its own body; the container this page fills it with sits inside it.
  const element = feedRef.value?.$el?.parentElement;

  if (element !== undefined && element !== null) {
    element.scrollTop = element.scrollHeight;
  }
}

async function copyAnswer(trial: Trial): Promise<void> {
  try {
    await navigator.clipboard.writeText(trial.answer ?? "");
  } catch {
    island.say({ title: t("common.error.copy_failed"), tone: "error" });
  }
}

async function ask(): Promise<void> {
  const prompt = input.value.trim();

  if (prompt === "" || sending.value) {
    return;
  }

  sending.value = true;
  await scrollToBottom();

  try {
    trials.value = [...trials.value, await $fetch<Trial>("/api/gate", { method: "POST", body: { stage, prompt } })];
    input.value = "";
    await scrollToBottom();
  } catch (error) {
    island.say({ title: refusalText(t, has, error, t("gates.error.call_failed")), tone: "error" });
  } finally {
    sending.value = false;
  }
}

let historyGeneration = 0;
onScopeDispose(() => { historyGeneration++; });

async function loadHistory(): Promise<void> {
  const mine = ++historyGeneration;
  historyError.value = "";
  pending.value = true;

  try {
    const answer = await $fetch<Trial[]>(`/api/gate/${encodeURIComponent(stage)}`);
    if (mine !== historyGeneration) return;
    trials.value = answer;
  } catch (error) {
    if (mine !== historyGeneration) return;
    historyError.value = refusalText(t, has, error, t("gates.error.records_failed"));
  } finally {
    if (mine === historyGeneration) pending.value = false;
  }
}

async function loadLaya(): Promise<void> {
  try {
    laya.value = await $fetch<LayaView>("/api/laya");
  } catch {
    // Without Laya's line the page stands all the same; the gate's settings say why where they are opened.
    laya.value = null;
  }
}

onMounted(async () => {
  await Promise.all([loadHistory(), loadLaya()]);
  await scrollToBottom();
});
</script>
