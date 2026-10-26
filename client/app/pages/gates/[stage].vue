<template>
  <UDashboardPanel id="gate" :ui="{ body: 'p-0 sm:p-0 overscroll-none' }">
    <!-- Under a console that offers its title bar the screen draws none of its own, and the gate's name and Laya line
         head its body instead (bmo-ui's `docs/console-bundles.md`, "The title bar"). -->
    <template v-if="!barOffered" #header>
      <UDashboardNavbar :title="label" :icon="GATE_ICON">
        <!-- The gate's Laya mode and how often Laya agrees with it, beside its name. -->
        <template #trailing>
          <span v-if="laya !== ''" class="hidden min-w-0 truncate text-sm text-muted tabular-nums sm:inline">{{ laya }}</span>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UContainer ref="feed" class="flex-1 flex flex-col gap-4 sm:gap-6 py-4 sm:py-6">
        <div v-if="barOffered" class="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 class="text-base font-semibold text-highlighted">{{ label }}</h2>
          <span v-if="laya !== ''" class="min-w-0 truncate text-sm text-muted tabular-nums">{{ laya }}</span>
        </div>
        <ContentSkeleton v-if="pending && trials.length === 0" :rows="4" listClass="flex flex-col gap-4 sm:gap-6" :label="t('gates.status.records_loading')">
          <div class="w-4/5 max-w-lg space-y-2 rounded-lg bg-elevated/40 p-3 even:self-end">
            <SkeletonLine width="w-24" />
            <SkeletonText :lines="2" size="sm" lastWidth="w-2/3" />
          </div>
        </ContentSkeleton>
        <div v-else-if="historyError" class="flex flex-col items-center gap-2 text-sm text-muted">
          <p>{{ historyError }}</p>
          <UButton size="sm" color="neutral" variant="soft" :label="t('gates.action.read_again')" :loading="pending" @click="loadHistory()" />
        </div>
        <p v-if="!pending && !historyError && trials.length === 0" class="text-center text-sm text-muted">
          {{ t("gates.status.no_trials") }}
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
                <span class="text-sm text-muted">{{ askedBy(trial) }}</span>
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
                <p v-if="trial.answer" class="whitespace-pre-wrap text-sm">{{ trial.answer }}</p>
                <p v-else class="text-muted italic">{{ t("gates.status.no_answer") }}</p>
              </template>

              <template #actions>
                <UTooltip :text="t('common.action.copy')">
                  <UButton
                    size="sm"
                    color="neutral"
                    variant="ghost"
                    icon="i-material-symbols-content-copy-outline"
                    :aria-label="t('gates.action.copy_answer')"
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
              <UChatShimmer :text="t('gates.status.judging')" />
            </template>
          </UChatMessage>
        </UChatMessages>
      </UContainer>
    </template>

    <template #footer>
      <div class="border-t border-default py-4">
        <UContainer>
          <UChatPrompt
            v-model="input"
            @keydown.capture="enter.keydown"
            @compositionend.capture="enter.compositionend"
            :submit-on-enter="submitOnEnter"
            :placeholder="t('gates.label.message')"
            :autofocus="false"
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
import { computed, inject, nextTick, onMounted, onScopeDispose, ref, useTemplateRef, watch } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";

import UButton from "@nuxt/ui/components/Button.vue";
import UChatMessage from "@nuxt/ui/components/ChatMessage.vue";
import UChatMessages from "@nuxt/ui/components/ChatMessages.vue";
import UChatPrompt from "@nuxt/ui/components/ChatPrompt.vue";
import UChatPromptSubmit from "@nuxt/ui/components/ChatPromptSubmit.vue";
import UChatShimmer from "@nuxt/ui/components/ChatShimmer.vue";
import UContainer from "@nuxt/ui/components/Container.vue";
import UDashboardNavbar from "@nuxt/ui/components/DashboardNavbar.vue";
import UDashboardPanel from "@nuxt/ui/components/DashboardPanel.vue";
import UTooltip from "@nuxt/ui/components/Tooltip.vue";

import ContentSkeleton from "bmo-ui/app/components/ContentSkeleton.vue";
import SkeletonLine from "bmo-ui/app/components/SkeletonLine.vue";
import SkeletonText from "bmo-ui/app/components/SkeletonText.vue";
import { useIsland } from "bmo-ui/app/domain/island";
import { usePromptEnter } from "bmo-ui/app/domain/prompt";
import { formatClock } from "bmo-ui/app/domain/time";

import { GATE_ICON, gateAddress, gateLabel, layaLine, refusalText } from "../../domain/gates";

import type { LayaView, Trial, TrialPage } from "../../../shared/gate";

const feedRef = useTemplateRef<{ $el?: HTMLElement }>("feed");

// Whether the console this screen stands in offers its own title bar, under the key the layer names for it.
const barOffered = inject("bmo-console-title-bar", null) !== null;
const route = useRoute();
const { t, te } = useI18n();
const island = useIsland(t);
const has = (key: string): boolean => te(key);

// The gate this page puts prompts to. Another gate is read afresh, whether the router opens a new page for it or
// hands this one the new path.
const stage = computed<string>(() => String(route.params.stage));
const label = computed<string>(() => gateLabel(t, has, stage.value));

const trials = ref<Trial[]>([]);
const input = ref("");
const { submitOnEnter, enter } = usePromptEnter(() => void ask());
const pending = ref(true);
const historyError = ref("");
const sending = ref(false);

// Laya as the gate answers it (the gate's docs/laya.md): read for this gate's mode and agreement, set only where the
// gate's options are set.
const layaView = ref<LayaView | null>(null);
const laya = computed<string>(() => layaLine(t, has, layaView.value, stage.value));

function formatDuration(ms: number): string {
  return t("common.label.seconds", { n: (ms / 1000).toFixed(1) });
}

// Who asked and when; a trial put through a console names nobody, so it is its time alone.
function askedBy(trial: Trial): string {
  const at = formatClock(trial.createdAt / 1000);

  return trial.userName === "" ? at : `${trial.userName} · ${at}`;
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
    island.say({ title: t("gates.error.copy_failed"), tone: "error" });
  }
}

async function ask(): Promise<void> {
  const prompt = input.value.trim();

  if (prompt === "" || sending.value) {
    return;
  }

  const gateName = stage.value;

  sending.value = true;
  await scrollToBottom();

  try {
    const trial = await $fetch<Trial>(gateAddress("/trials"), { method: "POST", body: { gateName, prompt } });

    if (gateName === stage.value) {
      trials.value = [...trials.value, trial];
      input.value = "";
      await scrollToBottom();
    }
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
    const answer = await $fetch<TrialPage>(gateAddress("/trials"), { query: { gateName: stage.value } });
    if (mine !== historyGeneration) return;
    trials.value = answer.items;
  } catch (error) {
    if (mine !== historyGeneration) return;
    historyError.value = refusalText(t, has, error, t("gates.error.records_failed"));
  } finally {
    if (mine === historyGeneration) pending.value = false;
  }
}

async function loadLaya(): Promise<void> {
  try {
    layaView.value = await $fetch<LayaView>(gateAddress("/laya"));
  } catch {
    // Without Laya's line the page stands all the same.
    layaView.value = null;
  }
}

// The gate read in the browser, when the page opens and whenever it is handed another gate.
async function open(): Promise<void> {
  trials.value = [];
  input.value = "";
  await Promise.all([loadHistory(), loadLaya()]);
  await scrollToBottom();
}

watch(stage, open);
onMounted(open);
</script>
