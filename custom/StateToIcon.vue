<template>
  <Tooltip v-if="job?.status === 'IN_PROGRESS' || status === 'IN_PROGRESS'">
    <Spinner class="w-5 h-5 ml-2" />
    <template #tooltip>
      {{ t('In progress') }}
    </template>
  </Tooltip>
  <Tooltip v-else-if="job?.status === 'DONE' || status === 'DONE'">
    <IconCheckCircleOutline  class="w-6 h-6 ml-2 text-green-500" />
    <template #tooltip>
      {{ t('Done') }}
    </template>
  </Tooltip>
  <Tooltip v-else-if="job?.status === 'CANCELLED' || status === 'CANCELLED'">
    <IconCloseCircleOutline class="w-6 h-6 ml-2 text-red-500" />
    <template #tooltip>
      {{ t('Cancelled') }}
    </template>
  </Tooltip>
  <Tooltip v-else-if="job?.status === 'DONE_WITH_ERRORS' || status === 'DONE_WITH_ERRORS'">
    <IconExclamationCircleOutline class="w-6 h-6 ml-2 text-yellow-500" />
    <template #tooltip>
      {{ t('Done with errors') }}
    </template>
  </Tooltip>
  <Tooltip v-else-if="status === 'FAILED'">
    <IconCloseCircleOutline class="w-6 h-6 ml-2 text-red-500" />
    <template #tooltip>
      {{ t('Failed') }}
    </template>
  </Tooltip>
  <Tooltip v-else-if="status === 'SCHEDULED'">
    <IconClockOutline class="w-6 h-6 ml-2 text-blue-500" />
    <template #tooltip>
      {{ t('Scheduled') }}
    </template>
  </Tooltip>
</template>


<script setup lang="ts">
  import type { IJob } from './utils';
  import { IconCheckCircleOutline, IconCloseCircleOutline, IconExclamationCircleOutline, IconClockOutline } from '@iconify-prerendered/vue-flowbite';
  import { Spinner, Tooltip } from '@/afcl';
  import { useI18n } from 'vue-i18n';

  const { t } = useI18n();

  const props = defineProps<{
    job?: IJob;
    status?: 'SCHEDULED' | 'IN_PROGRESS' | 'DONE' | 'FAILED' | 'CANCELLED' | 'DONE_WITH_ERRORS';
  }>();
</script>
