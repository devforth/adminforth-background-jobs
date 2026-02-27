<template> 
  <div class="flex flex-col ">
    <div class="flex flex-col">
      <div class="flex items-center mb-1">
        <h2 class="text-lg font-semibold">{{ job.name }}</h2>
        <p class="ml-2 text-xs text-gray-600 h-full"> {{ getTimeAgoString(new Date(job.createdAt)) }}</p>
        <p class="ml-auto text-gray-800 h-full"> {{  t('Progress:')  }} <span class="font-semibold" >{{ job.progress }}%</span></p>
        <StateToIcon :job="job" />
      </div>
      <div class="flex items-center gap-4">
        <ProgressBar 
          :current-value="job.progress" 
          :max-value="100" 
          :min-value="0"
          :showAnimation="job.status === 'IN_PROGRESS'"
          :showLabels="false"
          :showValues="false"
          :show-progress="false"
          :height="6"
        />
        <Button class="h-8"> Stop </Button>
      </div>
    </div>
    <slot></slot>
  </div>
</template>



<script setup lang="ts">
import type { IJob } from './utils';
import { ProgressBar, Button } from '@/afcl';
import { getTimeAgoString } from '@/utils';
import { useI18n } from 'vue-i18n';
import StateToIcon from './StateToIcon.vue';

const { t } = useI18n();


const props = defineProps<{
  job: IJob;
}>();
</script>