<template>
  <Tooltip v-if="job.status === 'IN_PROGRESS'">
    <Spinner class="w-4 h-4 ml-2" />
    <template #tooltip>
      {{ t('In progress') }}
    </template>
  </Tooltip>
  <Tooltip v-else-if="job.status === 'DONE'">
    <IconCheckCircleOutline  class="w-5 h-5 ml-2 text-green-500" />
      <template #tooltip>
        {{ t('Done') }}
      </template>
  </Tooltip>
  <Tooltip v-else-if="job.status === 'CANCELED'">
    <IconCloseCircleOutline class="w-5 h-5 ml-2 text-red-500" />
      <template #tooltip>
        {{ t('Canceled') }}
      </template>
  </Tooltip>
  <Tooltip v-else-if="job.status === 'DONE_WITH_ERRORS'">
    <IconExclamationCircleOutline class="w-5 h-5 ml-2 text-yellow-500" />
      <template #tooltip>
        {{ t('Done with errors') }}
      </template>
  </Tooltip>
</template>


<script setup lang="ts">
  import type { IJob } from './utils';
  import { IconCheckCircleOutline, IconCloseCircleOutline, IconExclamationCircleOutline } from '@iconify-prerendered/vue-flowbite';
  import { Spinner, Tooltip } from '@/afcl';
  import { useI18n } from 'vue-i18n';

  const { t } = useI18n();

  const props = defineProps<{
    job: IJob;
  }>();
</script>
