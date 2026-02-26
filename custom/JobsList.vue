<template>
  <div class="w-1vw md:w-64 bg-white border border-gray-200 rounded-md">
    <div v-for="job in props.jobs" :key="job.id" class="flex items-center px-4 py-3 border-b border-gray-200 hover:bg-gray-50 transition-colors">
      <div class="flex flex-col w-full max-w-48">
        <p class="flex gap-2 items-end justify-between text-nowrap">
          <span class="text-sm h-full text truncate">{{ job.name }}</span> 
          <span class="text-xs text-gray-600">{{ getTimeAgoString(new Date(job.createdAt)) }}</span> 
        </p>
        <ProgressBar 
          class="mt-1"
          :current-value="job.progress" 
          :max-value="100" 
          :min-value="0"
          :showAnimation="job.status === 'IN_PROGRESS'"
          :showLabels="false"
          :showValues="false"
          :show-progress="false"
        />
      </div>
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
    </div>
  </div>
</template>


<script setup lang="ts">
import type { IJob } from './utils';
import { getTimeAgoString } from '@/utils';
import { ProgressBar, Spinner, Tooltip } from '@/afcl';
import { IconCheckCircleOutline, IconCloseCircleOutline, IconExclamationCircleOutline } from '@iconify-prerendered/vue-flowbite';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

const props = defineProps<{
  jobs: IJob[];
}>();

  
</script>