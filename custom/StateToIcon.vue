<template>
  <Tooltip v-if="state">
    <span class="af-background-job-state flex items-center" :class="state.class" role="img" :aria-label="state.label">
      <Spinner v-if="currentStatus === 'IN_PROGRESS'" class="w-4 h-4" aria-hidden="true" />
      <component v-else :is="state.icon" class="w-4 h-4" aria-hidden="true" />
    </span>
    <template #tooltip>
      <p class="max-w-64 break-all">
        {{ state.label }}<template v-if="currentStatus === 'FAILED' && error">: {{ error }}</template>
      </p>
    </template>
  </Tooltip>
</template>


<script setup lang="ts">
  import type { Component } from 'vue';
  import { computed } from 'vue';
  import type { IJob } from './utils';
  import { IconBan, IconCircleAlert, IconCircleCheck, IconCircleX, IconClock, IconTrash2 } from '@iconify-prerendered/vue-lucide';
  import { Spinner, Tooltip } from '@/afcl';
  import { useI18n } from 'vue-i18n';

  type Status = 'SCHEDULED' | 'QUEUED' | 'IN_PROGRESS' | 'DONE' | 'FAILED' | 'CANCELLED' | 'DONE_WITH_ERRORS' | 'DELETED';

  const { t } = useI18n();

  const props = defineProps<{
    job?: IJob;
    status?: Status;
    error?: string;
  }>();

  const MUTED = 'text-lightInputIconColor dark:text-darkInputIconColor';

  const states = computed<Record<Status, { label: string; class: string; icon?: Component }>>(() => ({
    SCHEDULED: { label: t('Scheduled'), icon: IconClock, class: 'text-lightPrimary dark:text-darkPrimary' },
    QUEUED: { label: t('Queued'), icon: IconClock, class: MUTED },
    IN_PROGRESS: { label: t('In progress'), class: '' },
    DONE: { label: t('Done'), icon: IconCircleCheck, class: 'text-lightSuccess dark:text-darkSuccess' },
    DONE_WITH_ERRORS: { label: t('Done with errors'), icon: IconCircleAlert, class: 'text-lightWarning dark:text-darkWarning' },
    FAILED: { label: t('Failed'), icon: IconCircleX, class: 'text-lightDanger dark:text-darkDanger' },
    CANCELLED: { label: t('Cancelled'), icon: IconBan, class: MUTED },
    DELETED: { label: t('Deleted'), icon: IconTrash2, class: MUTED },
  }));

  const currentStatus = computed(() => props.job?.status ?? props.status);
  const state = computed(() => currentStatus.value && states.value[currentStatus.value]);
</script>
