<template>
  <UDashboardPanel id="gates">
    <template #header>
      <UDashboardNavbar :title="t('gates.title.gates')" :icon="GATE_ICON" />
    </template>

    <template #body>
      <UContainer class="flex flex-col gap-4 py-4 sm:gap-6 sm:py-6">
        <ContentSkeleton v-if="pending && gates.length === 0" :rows="6" listClass="flex flex-col gap-1" :label="t('gates.status.gates_loading')">
          <div class="flex items-center gap-3 px-2 py-2">
            <SkeletonLine width="w-6" />
            <SkeletonLine width="w-40" />
          </div>
        </ContentSkeleton>
        <div v-else-if="orderError" class="flex flex-col items-center gap-2 text-sm text-muted">
          <p>{{ orderError }}</p>
          <UButton size="sm" color="neutral" variant="soft" :label="t('gates.action.read_again')" :loading="pending" @click="load()" />
        </div>
        <p v-else-if="gates.length === 0" class="text-center text-sm text-muted">{{ t("gates.status.no_gates") }}</p>

        <!-- The gate order as the gate serves it, each run of gates under the part of a turn it stands in. -->
        <section v-for="(run, index) in runs" :key="`${index}-${run.part}`" class="flex flex-col gap-1">
          <h2 class="px-2 text-xs font-medium text-muted">{{ partLabel(t, has, run.part) }}</h2>
          <ULink
            v-for="gate in run.gates"
            :key="gate.gateName"
            :to="`/gates/${gate.gateName}`"
            class="flex min-w-0 items-center gap-3 rounded-md px-2 py-2 hover:bg-elevated/50"
          >
            <span class="w-6 shrink-0 text-right text-xs text-dimmed tabular-nums">{{ gate.step }}</span>
            <span class="min-w-0 flex-1 truncate text-sm text-highlighted">{{ gateLabel(t, has, gate.gateName) }}</span>
            <span v-if="layaLine(t, has, laya, gate.gateName) !== ''" class="shrink-0 text-xs text-muted tabular-nums">
              {{ layaLine(t, has, laya, gate.gateName) }}
            </span>
          </ULink>
        </section>
      </UContainer>
    </template>
  </UDashboardPanel>
</template>

<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from "vue";
import { useI18n } from "vue-i18n";

import UButton from "@nuxt/ui/components/Button.vue";
import UContainer from "@nuxt/ui/components/Container.vue";
import UDashboardNavbar from "@nuxt/ui/components/DashboardNavbar.vue";
import UDashboardPanel from "@nuxt/ui/components/DashboardPanel.vue";
import ULink from "@nuxt/ui/components/Link.vue";

import ContentSkeleton from "bmo-ui/app/components/ContentSkeleton.vue";
import SkeletonLine from "bmo-ui/app/components/SkeletonLine.vue";

import { byPart, GATE_ICON, gateAddress, gateLabel, layaLine, partLabel, refusalText } from "../../domain/gates";

import type { Gate, GatePage, LayaView } from "../../../shared/gate";

const { t, te } = useI18n();
const has = (key: string): boolean => te(key);

const gates = ref<Gate[]>([]);
const runs = computed(() => byPart(gates.value));
const pending = ref(true);
const orderError = ref("");

// Laya as the gate answers it, read for each probed gate's mode and agreement.
const laya = ref<LayaView | null>(null);

let generation = 0;
onScopeDispose(() => { generation++; });

async function loadOrder(mine: number): Promise<void> {
  try {
    const answer = await $fetch<GatePage>(gateAddress("/gates"));
    if (mine !== generation) return;
    gates.value = answer.items;
  } catch (error) {
    if (mine !== generation) return;
    orderError.value = refusalText(t, has, error, t("gates.error.gates_failed"));
  }
}

async function loadLaya(mine: number): Promise<void> {
  try {
    const answer = await $fetch<LayaView>(gateAddress("/laya"));
    if (mine === generation) laya.value = answer;
  } catch {
    // Without Laya's lines the order stands all the same.
    if (mine === generation) laya.value = null;
  }
}

async function load(): Promise<void> {
  const mine = ++generation;
  orderError.value = "";
  pending.value = true;

  await Promise.all([loadOrder(mine), loadLaya(mine)]);

  if (mine === generation) pending.value = false;
}

onMounted(load);
</script>
